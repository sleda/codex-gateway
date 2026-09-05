#!/usr/bin/env bun

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createGateway } from './gateway-tools.mjs'
import { sourceFingerprint } from './runtime-identity.mjs'
import { dispatchWorkspaceTool, workspaceDispatchTools } from './workspace-dispatch.mjs'
import { buildDynamicTools, classifyCodexMethod, createCodexProtocolCatalog } from './codex-protocol.mjs'
import { createStructuredResult } from './result-bounds.mjs'
import packageJson from '../package.json' with { type: 'json' }
import { readSkill, searchSkills } from './skill-catalog.mjs'

const GATEWAY_VERSION = packageJson.version
const RUNTIME_IDENTITY = Object.freeze({
  version: GATEWAY_VERSION,
  instanceId: randomBytes(12).toString('hex'),
  pid: process.pid,
  startedAt: new Date().toISOString(),
  sourceFingerprint: await sourceFingerprint(),
})
const MCP_VERSION = '2025-11-25'
const SUPPORTED_VERSIONS = new Set([MCP_VERSION, '2025-06-18', '2024-11-05'])
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_RESULT_CHARS = 40_000
const MAX_SESSION_CHARS = 1_000_000
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.turbo', 'DerivedData', 'build', 'dist'])
const DEFAULT_COMMANDS = new Set(['git', 'npm', 'npx', 'node', 'pnpm', 'rg', 'sed', 'swift', 'swiftformat', 'xcodebuildmcp'])
const IMAGE_TYPES = new Map([
  ['.gif', 'image/gif'], ['.jpeg', 'image/jpeg'], ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'], ['.webp', 'image/webp'],
])
const commandSessions = new Map()
const workspaceContext = new AsyncLocalStorage()
const codexAppServers = new Map()
let codexProtocolCatalogManager
let codexProtocolCatalogRoot
let xcodeDeveloperDirectoryPromise
let xcodeReadinessCache

const json = (value) => JSON.stringify(value, null, 2)
const trimResult = (value, max = MAX_RESULT_CHARS) => {
  const text = typeof value === 'string' ? value : json(value)
  return text.length > max ? `${text.slice(0, max)}\n… output truncated …` : text
}
function error(message, code = 'invalid_request') {
  const failure = new Error(message)
  failure.code = code
  return failure
}

async function workspaceRoot() {
  const root = await realpath(resolve(process.env.CODEX_GATEWAY_ROOT?.trim() || process.cwd()))
  if (!(await stat(root)).isDirectory()) throw error('CODEX_GATEWAY_ROOT must point to a directory', 'invalid_root')
  return root
}
async function workspaceGrantRoots() {
  const primary = await workspaceRoot()
  const configured = (process.env.CODEX_GATEWAY_WORKSPACE_ROOTS || '').split(':').map((value) => value.trim()).filter(Boolean)
  const roots = [primary]
  for (const pathname of configured) {
    let canonical
    try { canonical = await realpath(resolve(pathname)) } catch { continue }
    if ((await stat(canonical)).isDirectory() && !roots.includes(canonical)) roots.push(canonical)
  }
  return roots
}
async function selectedWorkspaceRoot(selector) {
  const primary = await workspaceRoot()
  if (selector === undefined || selector === null || selector === '' || selector === '.') return primary
  if (typeof selector !== 'string') throw error('workspace must be a string', 'invalid_workspace')
  const grants = await workspaceGrantRoots()
  const requested = isAbsolute(selector) ? resolve(selector) : resolve(primary, selector)
  let canonical
  try { canonical = await realpath(requested) } catch (cause) {
    throw error(`Workspace does not exist: ${selector}`, 'workspace_not_found')
  }
  if (!(await stat(canonical)).isDirectory()) throw error('workspace must refer to a directory', 'invalid_workspace')
  if (!grants.some((grant) => {
    const relation = relative(grant, canonical)
    return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  })) throw error('Workspace is outside the configured workspace grants', 'workspace_not_granted')
  return canonical
}
async function activeWorkspaceRoot() {
  return workspaceContext.getStore()?.root || await workspaceRoot()
}
async function discoverWorkspaces() {
  const roots = await workspaceGrantRoots()
  const workspaces = []
  const seen = new Set()
  for (const grant of roots) {
    const candidates = [{ path: grant, depth: 0 }]
    while (candidates.length && workspaces.length < 500) {
      const current = candidates.shift()
      if (!current || seen.has(current.path) || current.depth > 3) continue
      seen.add(current.path)
      let children
      try { children = await readdir(current.path, { withFileTypes: true }) } catch { continue }
      const hasGit = children.some((entry) => entry.name === '.git')
      if (hasGit) {
        workspaces.push({
          name: basename(current.path),
          path: current.path,
          selector: current.path === (await workspaceRoot()) ? '.' : relative(await workspaceRoot(), current.path),
          grant,
        })
        continue
      }
      for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!child.isDirectory() || IGNORED_DIRS.has(child.name) || child.name.startsWith('.')) continue
        candidates.push({ path: join(current.path, child.name), depth: current.depth + 1 })
      }
    }
  }
  return { primaryRoot: await workspaceRoot(), grants: roots, workspaces }
}
function assertInside(root, candidate) {
  const relation = relative(root, candidate)
  if (relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))) return candidate
  throw error('Path must stay inside the configured workspace root', 'path_outside_workspace')
}
async function safeWorkspaceAddress(root, input, { allowMissing = false } = {}) {
  if (typeof input !== 'string' || input.trim() === '') throw error('path is required')
  const candidate = assertInside(root, isAbsolute(input) ? resolve(input) : resolve(root, input))
  try {
    return assertInside(root, await realpath(candidate))
  } catch (cause) {
    if (!allowMissing || cause?.code !== 'ENOENT') throw cause
    let parentCandidate = dirname(candidate)
    while (true) {
      try {
        const parent = assertInside(root, await realpath(parentCandidate))
        return join(parent, relative(parentCandidate, candidate))
      } catch (parentCause) {
        if (parentCause?.code !== 'ENOENT' || parentCandidate === root) throw parentCause
        parentCandidate = dirname(parentCandidate)
      }
    }
  }
}
async function safePath(root, input, { allowMissing = false } = {}) {
  if (typeof input !== 'string' || input.trim() === '') throw error('path is required')
  if (isAbsolute(input)) throw error('Absolute paths are not allowed; use a workspace-relative path')
  const candidate = assertInside(root, resolve(root, input))
  try {
    return assertInside(root, await realpath(candidate))
  } catch (cause) {
    if (!allowMissing || cause?.code !== 'ENOENT') throw cause
    let parentCandidate = dirname(candidate)
    while (true) {
      try {
        const parent = assertInside(root, await realpath(parentCandidate))
        return join(parent, relative(parentCandidate, candidate))
      } catch (parentCause) {
        if (parentCause?.code !== 'ENOENT' || parentCandidate === root) throw parentCause
        parentCandidate = dirname(parentCandidate)
      }
    }
  }
}
function assertSensitiveWriteAllowed(pathname) {
  const value = pathname.toLowerCase()
  const envTemplate = /(^|\/)\.env\.(?:example|sample|template)(?:\.|$)/.test(value)
  const sensitive = !envTemplate && (value === '.env' || value.startsWith('.env.') || value.includes('/.env') || value.includes('credentials') || value.includes('secrets'))
  if (sensitive && process.env.CODEX_GATEWAY_ALLOW_SENSITIVE_WRITES !== '1') {
    throw error('Writes to environment, credentials, and secrets files are disabled', 'sensitive_write_blocked')
  }
}
function requireWriteConfirmation(input) {
  if (process.env.CODEX_GATEWAY_ALLOW_WRITES !== '1') throw error('Write tools are disabled. Set CODEX_GATEWAY_ALLOW_WRITES=1.', 'writes_disabled')
  if (input?.confirmation !== true) throw error('Set confirmation=true after reviewing the exact change.', 'confirmation_required')
}
function requireCommandAccess() {
  if (process.env.CODEX_GATEWAY_ALLOW_COMMANDS !== '1') throw error('Command execution is disabled. Set CODEX_GATEWAY_ALLOW_COMMANDS=1.', 'commands_disabled')
}
function requireCodexAccess() {
  if (process.env.CODEX_GATEWAY_ENABLE_CODEX !== '1') throw error('Codex tools are disabled. Set CODEX_GATEWAY_ENABLE_CODEX=1.', 'codex_disabled')
}
function requireCodexMutation(input, confirmationField = 'confirmation') {
  requireCodexAccess()
  if (process.env.CODEX_GATEWAY_ALLOW_CODEX_MUTATIONS !== '1') throw error('Codex mutation tools are disabled. Set CODEX_GATEWAY_ALLOW_CODEX_MUTATIONS=1.', 'codex_mutations_disabled')
  if (input?.[confirmationField] !== true) throw error(`Set ${confirmationField}=true after reviewing the exact Codex action.`, 'confirmation_required')
}
function commandAllowlist() {
  const configured = process.env.CODEX_GATEWAY_COMMAND_ALLOWLIST?.split(',').map((item) => item.trim()).filter(Boolean)
  return new Set(configured?.length ? configured : DEFAULT_COMMANDS)
}
function managedCommandRoots(command) {
  const executable = command.split(/[\\/]/).at(-1)
  if (executable !== 'xcodebuildmcp') return []
  return [resolve(process.env.CODEX_GATEWAY_XCODEBUILDMCP_DATA_ROOT?.trim() || join(homedir(), 'Library', 'Developer', 'XcodeBuildMCP'))]
}
async function safeCommandAddress(boundaryRoot, command, pathname, { allowMissing = false } = {}) {
  try {
    return await safeWorkspaceAddress(boundaryRoot, pathname, { allowMissing })
  } catch (cause) {
    if (cause?.code !== 'path_outside_workspace') throw cause
  }
  for (const configuredRoot of managedCommandRoots(command)) {
    let managedRoot
    try { managedRoot = await realpath(configuredRoot) } catch { managedRoot = configuredRoot }
    try { return await safeWorkspaceAddress(managedRoot, pathname, { allowMissing }) } catch (cause) {
      if (cause?.code !== 'path_outside_workspace') throw cause
    }
  }
  throw error('Command path is outside the selected workspace and managed command artifact roots', 'path_outside_workspace')
}
async function isFullXcodeDeveloperDirectory(pathname) {
  if (!pathname) return false
  try {
    const [xcodebuild, xctrace] = await Promise.all([
      stat(join(pathname, 'usr', 'bin', 'xcodebuild')),
      stat(join(pathname, 'usr', 'bin', 'xctrace')),
    ])
    return xcodebuild.isFile() && xctrace.isFile()
  } catch {
    return false
  }
}
async function discoverXcodeDeveloperDirectory() {
  const explicit = [process.env.CODEX_GATEWAY_XCODE_DEVELOPER_DIR, process.env.DEVELOPER_DIR]
    .map((value) => value?.trim()).filter(Boolean)
  for (const candidate of explicit) {
    if (await isFullXcodeDeveloperDirectory(candidate)) return { path: candidate, source: 'environment' }
  }
  const roots = ['/Applications', join(homedir(), 'Applications'), join(homedir(), 'Downloads')]
  const candidates = []
  for (const root of roots) {
    for (const bundleName of ['Xcode-beta.app', 'Xcode.app']) {
      const developerDirectory = join(root, bundleName, 'Contents', 'Developer')
      if (await isFullXcodeDeveloperDirectory(developerDirectory)) candidates.push(developerDirectory)
    }
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^Xcode.*\.app$/i.test(entry.name)) continue
        const developerDirectory = join(root, entry.name, 'Contents', 'Developer')
        if (await isFullXcodeDeveloperDirectory(developerDirectory) && !candidates.includes(developerDirectory)) candidates.push(developerDirectory)
      }
    } catch (cause) {
      if (!['ENOENT', 'EACCES', 'EPERM'].includes(cause?.code)) throw cause
    }
  }
  candidates.sort((left, right) => {
    const betaDifference = Number(/beta/i.test(right)) - Number(/beta/i.test(left))
    return betaDifference || left.localeCompare(right)
  })
  return candidates.length ? { path: candidates[0], source: 'auto-discovery' } : null
}
async function xcodeDeveloperDirectory() {
  xcodeDeveloperDirectoryPromise ||= discoverXcodeDeveloperDirectory()
  return await xcodeDeveloperDirectoryPromise
}
async function normalizedHostEnvironment({ requireXcode = false } = {}) {
  const env = { ...process.env }
  if (process.platform === 'darwin') {
    // Apple command shims in user-local PATH entries can silently pin a stale
    // Xcode. Keep the rest of the user's PATH, but resolve platform tools first.
    const systemToolPath = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
    const currentPath = (env.PATH || '').split(':').filter(Boolean)
    env.PATH = [...new Set([...systemToolPath, ...currentPath])].join(':')
    const developerDirectory = await xcodeDeveloperDirectory()
    if (developerDirectory) env.DEVELOPER_DIR = developerDirectory.path
    else if (requireXcode) throw error('No full Xcode developer directory with xcodebuild and xctrace was found. Set CODEX_GATEWAY_XCODE_DEVELOPER_DIR.', 'xcode_developer_dir_not_found')
    else delete env.DEVELOPER_DIR
  }
  return env
}
async function commandEnvironment(command) {
  const executable = command.split(/[\\/]/).at(-1)
  if (executable !== 'xcodebuildmcp') return process.env
  return await normalizedHostEnvironment({ requireXcode: true })
}
async function xcodeDevelopmentStatus(root) {
  const now = Date.now()
  if (xcodeReadinessCache && now - xcodeReadinessCache.checkedAt < 60_000) return xcodeReadinessCache.value
  const xcode = await xcodeDeveloperDirectory()
  if (!xcode || !commandAllowlist().has('xcodebuildmcp')) {
    const value = {
      xcodebuildmcpAllowed: commandAllowlist().has('xcodebuildmcp'),
      developerDirectory: xcode?.path || null,
      developerDirectorySource: xcode?.source || null,
      ready: false,
      simulatorReady: false,
      probe: xcode ? 'xcodebuildmcp_not_allowlisted' : 'xcode_not_found',
    }
    xcodeReadinessCache = { checkedAt: now, value }
    return value
  }
  const result = await runProcess('xcodebuildmcp', ['simulator', 'list'], root, { timeoutMs: 30_000 })
  const value = {
    xcodebuildmcpAllowed: true,
    developerDirectory: xcode.path,
    developerDirectorySource: xcode.source,
    ready: result.exitCode === 0 && result.timedOut !== true,
    simulatorReady: result.exitCode === 0 && result.timedOut !== true,
    probe: 'xcodebuildmcp simulator list',
    probeExitCode: result.exitCode,
    probeError: result.exitCode === 0 ? null : (result.stderr || result.stdout || null),
  }
  xcodeReadinessCache = { checkedAt: now, value }
  return value
}
function classifyCommand(command, args = []) {
  const executable = command.split(/[\\/]/).at(-1)
  if (executable === 'rg' && !args.some((arg) => arg === '--pre' || arg.startsWith('--pre='))) return { readOnly: true, risk: 'read-only' }
  if (executable === 'git') {
    const subcommand = args.find((arg) => !arg.startsWith('-'))
    const unsafeFlag = args.some((arg) => arg === '--ext-diff' || arg === '--textconv')
    if (!unsafeFlag && new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'grep', 'cat-file', 'name-rev']).has(subcommand)) return { readOnly: true, risk: 'read-only' }
  }
  if (executable === 'xcodebuildmcp') {
    if (args.length === 0 || args.includes('--help') || args.includes('-h') || args.includes('--version') || args.includes('-v') || args[0] === 'tools') return { readOnly: true, risk: 'read-only' }
    const workflow = args[0]
    const action = args[1]
    const safeActions = new Set(['list', 'list-schemes', 'show-build-settings', 'discover-projects', 'get-app-path', 'get-app-bundle-id', 'get-macos-bundle-id', 'snapshot-ui'])
    if (safeActions.has(action) || workflow === 'project-discovery' && !['clean'].includes(action)) return { readOnly: true, risk: 'read-only' }
  }
  return { readOnly: false, risk: new Set(['node', 'npm', 'npx', 'pnpm', 'swift']).has(executable) ? 'general-execution' : 'mutation' }
}
function requireCommandConfirmation(input, policy) {
  if (policy.readOnly) return
  if (input?.confirmation !== true) throw error(`Command requires confirmation=true (${policy.risk}).`, 'confirmation_required')
}
function pathLikeField(key) {
  const value = String(key || '').toLowerCase()
  return value === 'path' || value === 'cwd' || value.endsWith('path') || value.endsWith('paths') || value.endsWith('root') || value.endsWith('roots') || value.endsWith('directory') || value.endsWith('directories') || value.endsWith('destination')
}
async function enforceDynamicCodexWorkspace(method, params, root) {
  const visit = async (value, key = '') => {
    if (typeof value === 'string') {
      if (pathLikeField(key) && value.trim()) {
        const candidate = isAbsolute(value) ? value : resolve(root, value)
        await safeWorkspaceAddress(root, candidate, { allowMissing: true })
      }
      return
    }
    if (Array.isArray(value)) {
      if (pathLikeField(key)) {
        for (const entry of value) {
          if (typeof entry !== 'string' || !entry.trim()) continue
          const candidate = isAbsolute(entry) ? entry : resolve(root, entry)
          await safeWorkspaceAddress(root, candidate, { allowMissing: true })
        }
      } else {
        for (const entry of value) if (entry && typeof entry === 'object') await visit(entry, key)
      }
      return
    }
    if (!value || typeof value !== 'object') return
    for (const [nestedKey, nested] of Object.entries(value)) {
      if (nestedKey === 'env') continue
      await visit(nested, nestedKey)
    }
  }
  if (method.startsWith('fs/')) {
    const inspectFs = async (value) => {
      if (typeof value === 'string') {
        if (value.trim()) await safeWorkspaceAddress(root, isAbsolute(value) ? value : resolve(root, value), { allowMissing: true })
        return
      }
      if (Array.isArray(value)) { for (const entry of value) await inspectFs(entry); return }
      if (value && typeof value === 'object') for (const [key, nested] of Object.entries(value)) if (key !== 'dataBase64') await inspectFs(nested)
    }
    await inspectFs(params)
  } else await visit(params)

  if ((method === 'process/spawn' || method === 'command/exec') && Array.isArray(params?.command)) {
    const executable = typeof params.command[0] === 'string' ? params.command[0] : ''
    const commandCwd = typeof params?.cwd === 'string' && params.cwd.trim()
      ? (isAbsolute(params.cwd) ? params.cwd : resolve(root, params.cwd))
      : root
    for (const argument of params.command.slice(1)) {
      if (typeof argument !== 'string') continue
      const equalsIndex = argument.indexOf('=')
      const possiblePath = equalsIndex > 0 && argument.startsWith('--') ? argument.slice(equalsIndex + 1) : argument
      if (isAbsolute(possiblePath)) {
        await safeCommandAddress(root, executable, possiblePath, { allowMissing: true })
      } else if (possiblePath === '..' || possiblePath.startsWith(`..${sep}`) || possiblePath.includes(`${sep}..${sep}`)) {
        await safeCommandAddress(root, executable, resolve(commandCwd, possiblePath), { allowMissing: true })
      }
    }
  }
}
async function validateCommand(command, args, timeoutMs, boundaryRoot, cwd = boundaryRoot) {
  const executable = command.split(/[\\/]/).at(-1)
  if (!executable || !commandAllowlist().has(executable)) throw error(`Command is not allowlisted: ${command}`, 'command_not_allowed')
  if (command !== executable && process.env.CODEX_GATEWAY_ALLOW_EXTERNAL_PATHS !== '1') throw error('Executable paths are not allowed; use an allowlisted executable name resolved through PATH', 'command_path_not_allowed')
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw error('args must be an array of strings')
  if (process.env.CODEX_GATEWAY_ALLOW_EXTERNAL_PATHS !== '1') {
    for (const arg of args) {
      const equalsIndex = arg.indexOf('=')
      const possiblePath = equalsIndex > 0 && arg.startsWith('--') ? arg.slice(equalsIndex + 1) : arg
      if (isAbsolute(possiblePath)) await safeCommandAddress(boundaryRoot, command, possiblePath, { allowMissing: true })
      else if (possiblePath === '..' || possiblePath.startsWith(`..${sep}`) || possiblePath.includes(`${sep}..${sep}`)) {
        await safeCommandAddress(boundaryRoot, command, resolve(cwd, possiblePath), { allowMissing: true })
      }
    }
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw error('timeoutMs must be between 1 and 300000')
}
async function atomicWrite(pathname, content) {
  const temporary = `${pathname}.codex-gateway-${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  try {
    let mode = 0o600
    try { mode = (await stat(pathname)).mode & 0o777 } catch (cause) { if (cause?.code !== 'ENOENT') throw cause }
    await writeFile(temporary, content, { encoding: 'utf8', mode })
    await rename(temporary, pathname)
  } catch (cause) {
    await import('node:fs/promises').then(({ unlink }) => unlink(temporary).catch(() => undefined))
    throw cause
  }
}

function goalStateDirectory() {
  return resolve(process.env.CODEX_GATEWAY_STATE_DIR?.trim() || join(homedir(), '.local', 'state', 'codex-gateway'))
}
async function goalStatePath(root) {
  const stateDirectory = goalStateDirectory()
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
  const workspaceId = createHash('sha256').update(root).digest('hex').slice(0, 24)
  return join(stateDirectory, `goal-${workspaceId}.json`)
}
async function readGoal(root) {
  const pathname = await goalStatePath(root)
  try {
    const goal = JSON.parse(await readFile(pathname, 'utf8'))
    if (goal?.workspace !== root || typeof goal?.objective !== 'string') throw error('Stored goal state is invalid', 'invalid_goal_state')
    return goal
  } catch (cause) {
    if (cause?.code === 'ENOENT') return null
    throw cause
  }
}
async function writeGoal(root, goal) {
  const pathname = await goalStatePath(root)
  await atomicWrite(pathname, `${JSON.stringify(goal, null, 2)}\n`)
  return goal
}
function goalContinuation(goal) {
  if (!goal || goal.status !== 'active') return null
  return {
    continueInCurrentTurn: true,
    instruction: 'Continue working on this goal in the current assistant turn. Choose the next concrete step, discover and call the required tools, then save another checkpoint. Do not stop merely to ask the user to say continue. Stop only when the goal is complete, genuinely blocked on user input or approval, or the platform ends the turn.',
    objective: goal.objective,
    summary: goal.summary,
    nextSteps: goal.nextSteps,
  }
}
const structuredGoalResult = (goal) => structuredResult({ goal, continuation: goalContinuation(goal) })

async function runProcess(command, args, cwd, { timeoutMs = 120_000, stdin } = {}) {
  await validateCommand(command, args, timeoutMs, cwd, cwd)
  const env = await commandEnvironment(command)
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, env, shell: false })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolvePromise({ ...result, stdout: trimResult(stdout), stderr: trimResult(stderr) })
    }
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref()
      finish({ exitCode: null, signal: 'SIGTERM', timedOut: true })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (cause) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      rejectPromise(error(`Failed to start ${command}: ${cause.message}`, 'command_failed_to_start'))
    })
    child.on('close', (exitCode, signal) => finish({ exitCode, signal, timedOut: false }))
    child.stdin.end(stdin)
  })
}
function appendSessionOutput(session, stream, chunk) {
  session[stream] += chunk.toString()
  if (session[stream].length > MAX_SESSION_CHARS) {
    const removed = session[stream].length - MAX_SESSION_CHARS
    session[stream] = session[stream].slice(removed)
    session[`${stream}Offset`] = Math.max(0, session[`${stream}Offset`] - removed)
    session.truncated = true
  }
}
function drainSession(session, maxChars) {
  const stdout = session.stdout.slice(session.stdoutOffset)
  const stderr = session.stderr.slice(session.stderrOffset)
  session.stdoutOffset = session.stdout.length
  session.stderrOffset = session.stderr.length
  return {
    sessionId: session.id, running: session.running, exitCode: session.exitCode,
    signal: session.signal, timedOut: session.timedOut,
    stdout: trimResult(stdout, maxChars), stderr: trimResult(stderr, maxChars),
    outputTruncated: session.truncated || stdout.length > maxChars || stderr.length > maxChars,
  }
}
async function startCommandSession(command, args, cwd, timeoutMs, boundaryRoot = cwd) {
  await validateCommand(command, args, timeoutMs, boundaryRoot, cwd)
  const env = await commandEnvironment(command)
  const child = spawn(command, args, { cwd, env, shell: false })
  const session = {
    id: randomBytes(12).toString('hex'), child, running: true, exitCode: null,
    signal: null, timedOut: false, stdout: '', stderr: '', stdoutOffset: 0,
    stderrOffset: 0, truncated: false,
  }
  session.closed = new Promise((resolvePromise, rejectPromise) => {
    child.on('error', (cause) => { session.running = false; rejectPromise(error(`Failed to start ${command}: ${cause.message}`, 'command_failed_to_start')) })
    child.on('close', (exitCode, signal) => {
      session.running = false
      session.exitCode = exitCode
      session.signal = signal
      clearTimeout(session.timeout)
      resolvePromise()
    })
  })
  child.stdout.on('data', (chunk) => appendSessionOutput(session, 'stdout', chunk))
  child.stderr.on('data', (chunk) => appendSessionOutput(session, 'stderr', chunk))
  session.timeout = setTimeout(() => {
    session.timedOut = true
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), 2_000).unref()
  }, timeoutMs)
  commandSessions.set(session.id, session)
  return session
}
const waitForSession = async (session, milliseconds) => await Promise.race([
  session.closed,
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
])

async function listFiles(root, input = {}) {
  const start = await safePath(root, input.path || '.')
  if (!(await stat(start)).isDirectory()) throw error('path must refer to a directory')
  const maxEntries = Math.min(Math.max(input.maxEntries || 200, 1), 2_000)
  const maxDepth = Math.min(Math.max(input.maxDepth ?? 20, 0), 50)
  const offset = input.cursor === undefined ? 0 : Number.parseInt(input.cursor, 10)
  if (!Number.isInteger(offset) || offset < 0) throw error('cursor must be a non-negative integer string', 'invalid_cursor')
  const entries = []
  let visited = 0
  let hasMore = false
  async function visit(directory, depth) {
    if (hasMore) return
    const children = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const child of children) {
      if (hasMore) return
      if (child.isDirectory() && IGNORED_DIRS.has(child.name)) continue
      const full = join(directory, child.name)
      if (visited++ >= offset) {
        if (entries.length >= maxEntries) { hasMore = true; return }
        entries.push({ path: relative(root, full), type: child.isDirectory() ? 'directory' : 'file' })
      }
      if (child.isDirectory() && depth < maxDepth) await visit(full, depth + 1)
    }
  }
  await visit(start, 0)
  const nextCursor = hasMore ? String(offset + entries.length) : null
  return {
    root,
    path: relative(root, start) || '.',
    cursor: String(offset),
    nextCursor,
    truncated: nextCursor !== null,
    maxDepth,
    entries,
  }
}
function patchPaths(patch) {
  if (typeof patch !== 'string' || patch.trim() === '') throw error('patch is required')
  const paths = new Set()
  for (const line of patch.split('\n')) {
    const match = /^(?:---|\+\+\+)\s+([^\t]+)(?:\t.*)?$/.exec(line)
    if (!match || match[1] === '/dev/null') continue
    if (match[1].startsWith('"')) throw error('Quoted patch paths are not supported', 'unsupported_patch_path')
    paths.add(match[1].replace(/^[ab]\//, ''))
  }
  if (!paths.size || paths.has('')) throw error('Patch does not contain valid file paths', 'invalid_patch')
  return [...paths]
}
async function validatePatch(root, patch) {
  for (const pathname of patchPaths(patch)) {
    const resolved = await safePath(root, pathname, { allowMissing: true })
    assertSensitiveWriteAllowed(relative(root, resolved))
  }
}
const structuredResult = (value) => createStructuredResult(value, MAX_RESULT_CHARS)
function remediationForError(cause) {
  const code = cause?.code || 'tool_error'
  const known = {
    confirmation_required: 'Review the exact mutation or command and retry with confirmation=true.',
    workspace_not_granted: 'Choose a workspace inside CODEX_GATEWAY_ROOT/CODEX_GATEWAY_WORKSPACE_ROOTS or update the runtime grants.',
    workspace_not_found: 'Run workspace_list and choose an existing granted workspace.',
    command_not_readonly: 'Use exec_command with confirmation=true for mutation-capable commands.',
    xcode_developer_dir_not_found: 'Install/select full Xcode or set CODEX_GATEWAY_XCODE_DEVELOPER_DIR.',
    codex_mutations_disabled: 'Use a full-mode Gateway runtime when Codex mutations are intentionally required.',
    codex_timeout: 'Retry the request; if it persists, inspect Codex app-server diagnostics and events.',
  }
  return known[code] || null
}
function structuredErrorResult(cause) {
  const errorValue = {
    code: cause?.code || 'tool_error',
    message: cause?.message || String(cause),
    retryable: Boolean(cause?.retryable || cause?.code === 'codex_timeout'),
    ...(cause?.rpcCode === undefined ? {} : { rpcCode: cause.rpcCode }),
    ...(cause?.rpcData === undefined || cause?.rpcData === null ? {} : { rpcData: cause.rpcData }),
    ...(remediationForError(cause) ? { remediation: remediationForError(cause) } : {}),
  }
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: errorValue.code, message: errorValue.message }) }],
    structuredContent: { ok: false, error: errorValue },
    isError: true,
  }
}

function parseJsonLines(buffer, onMessage, onInvalidLine) {
  let pending = buffer
  let newline
  while ((newline = pending.indexOf('\n')) !== -1) {
    const line = pending.slice(0, newline).trim()
    pending = pending.slice(newline + 1)
    if (!line) continue
    try { onMessage(JSON.parse(line)) } catch (cause) { onInvalidLine?.(line, cause) }
  }
  return pending
}
class CodexAppServerClient {
  constructor(root) {
    this.root = root
    this.child = null
    this.starting = null
    this.pending = new Map()
    this.sequence = 0
    this.stdoutBuffer = ''
    this.lastError = null
    this.initializeResult = null
    this.eventSequence = 0
    this.events = []
    this.pendingHostRequests = new Map()
    this.eventWaiters = new Set()
  }
  async start() {
    requireCodexAccess()
    if (this.child) return
    if (this.starting) return await this.starting
    this.starting = this.#start()
    try { await this.starting } finally { this.starting = null }
  }
  async #start() {
    const command = process.env.CODEX_GATEWAY_CODEX_COMMAND || '/Applications/ChatGPT.app/Contents/Resources/codex'
    const env = await normalizedHostEnvironment()
    const child = spawn(command, ['app-server', '--listen', 'stdio://'], { cwd: this.root, env, shell: false })
    this.child = child
    this.lastError = null
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      this.stdoutBuffer += chunk
      this.stdoutBuffer = parseJsonLines(this.stdoutBuffer, (message) => this.#onMessage(message), (line, cause) => {
        process.stderr.write(`[codex-gateway:codex] invalid JSON: ${cause.message}; line=${line.slice(0, 500)}\n`)
      })
    })
    child.stderr.on('data', (chunk) => process.stderr.write(`[codex-gateway:codex] ${chunk}`))
    child.on('error', (cause) => this.#closeWithError(cause))
    child.on('close', (exitCode, signal) => this.#closeWithError(error(`Codex app-server closed (exit=${exitCode}, signal=${signal})`, 'codex_app_server_closed')))
    try {
      this.initializeResult = await this.request('initialize', {
        clientInfo: { name: 'codex-gateway', title: 'Codex Gateway', version: GATEWAY_VERSION },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      }, 30_000)
      this.notify('initialized', {})
      process.stderr.write('[codex-gateway:codex] connected\n')
    } catch (cause) {
      this.close()
      throw cause
    }
  }
  #recordEvent(event) {
    const value = { sequence: ++this.eventSequence, receivedAt: new Date().toISOString(), ...event }
    this.events.push(value)
    if (this.events.length > 1_000) this.events.splice(0, this.events.length - 1_000)
    for (const resolveWaiter of this.eventWaiters) resolveWaiter()
    this.eventWaiters.clear()
    return value
  }
  #onMessage(message) {
    if (message?.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timeout)
      if (message.error) {
        const failure = error(message.error.message || json(message.error), 'codex_request_failed')
        failure.rpcCode = message.error.code ?? null
        failure.rpcData = message.error.data ?? null
        failure.retryable = message.error.code === -32001
        pending.reject(failure)
      } else pending.resolve(message.result)
      return
    }
    if (message?.id !== undefined && typeof message.method === 'string') {
      const requestId = String(message.id)
      this.pendingHostRequests.set(requestId, { requestId, rpcId: message.id, method: message.method, params: message.params ?? null, receivedAt: new Date().toISOString() })
      this.#recordEvent({ type: 'serverRequest', requestId, method: message.method, params: message.params ?? null })
      return
    }
    if (typeof message?.method === 'string') this.#recordEvent({ type: 'notification', method: message.method, params: message.params ?? null })
  }
  listEvents({ afterSequence = 0, limit = 100 } = {}) {
    const boundedLimit = Math.min(Math.max(limit || 100, 1), 500)
    const events = this.events.filter((entry) => entry.sequence > afterSequence).slice(0, boundedLimit)
    return { events, latestSequence: this.eventSequence, nextSequence: events.at(-1)?.sequence ?? afterSequence }
  }
  listPendingHostRequests() {
    return [...this.pendingHostRequests.values()].map(({ rpcId: _rpcId, ...request }) => request)
  }
  respondHostRequest(requestId, { result, rpcError } = {}) {
    const pending = this.pendingHostRequests.get(String(requestId))
    if (!pending) throw error(`Unknown Codex host request: ${requestId}`, 'codex_host_request_not_found')
    if (!this.child?.stdin.writable) throw error('Codex app-server is not connected', 'codex_unavailable')
    const response = rpcError
      ? { jsonrpc: '2.0', id: pending.rpcId, error: rpcError }
      : { jsonrpc: '2.0', id: pending.rpcId, result: result ?? {} }
    this.child.stdin.write(`${JSON.stringify(response)}\n`)
    this.pendingHostRequests.delete(String(requestId))
    this.#recordEvent({ type: 'serverRequestResolved', requestId: String(requestId), method: pending.method, response: rpcError ? { error: rpcError } : { result: result ?? {} } })
    return { requestId: String(requestId), method: pending.method, resolved: true }
  }
  async waitForEvents(afterSequence = 0, timeoutMs = 15_000) {
    const immediate = this.listEvents({ afterSequence })
    if (immediate.events.length) return immediate
    let wake
    const eventPromise = new Promise((resolvePromise) => {
      wake = resolvePromise
      this.eventWaiters.add(wake)
    })
    try {
      await Promise.race([eventPromise, new Promise((resolvePromise) => setTimeout(resolvePromise, timeoutMs))])
    } finally {
      if (wake) this.eventWaiters.delete(wake)
    }
    return this.listEvents({ afterSequence })
  }
  request(method, params = {}, timeoutMs = 60_000) {
    if (!this.child?.stdin.writable) return Promise.reject(error('Codex app-server is not connected', 'codex_unavailable'))
    return new Promise((resolvePromise, rejectPromise) => {
      const id = ++this.sequence
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        rejectPromise(error(`Codex request timed out: ${method}`, 'codex_timeout'))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timeout })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }
  notify(method, params = {}) {
    if (this.child?.stdin.writable) this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }
  #closeWithError(cause) {
    if (!this.child && !this.pending.size) return
    this.lastError = cause?.message || String(cause)
    this.child = null
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(cause)
    }
    this.pending.clear()
  }
  close() {
    const child = this.child
    this.child = null
    if (child && !child.killed) child.kill('SIGTERM')
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error('Codex app-server stopped', 'codex_unavailable'))
    }
    this.pending.clear()
    this.pendingHostRequests.clear()
    for (const resolveWaiter of this.eventWaiters) resolveWaiter()
    this.eventWaiters.clear()
  }
}
async function codexClient() {
  requireCodexAccess()
  const root = await activeWorkspaceRoot()
  let protocolFingerprint = null
  try { protocolFingerprint = await codexExecutableFingerprint() } catch {}
  let client = codexAppServers.get(root)
  if (client && protocolFingerprint && client.protocolFingerprint && client.protocolFingerprint !== protocolFingerprint) {
    client.close()
    codexAppServers.delete(root)
    client = null
  }
  if (!client) {
    client = new CodexAppServerClient(root)
    client.protocolFingerprint = protocolFingerprint
    codexAppServers.set(root, client)
  }
  await client.start()
  return client
}
async function codexRequest(method, params = {}, timeoutMs) {
  const policy = classifyCodexMethod(method)
  const maxAttempts = policy.readOnly ? 4 : 1
  let lastFailure
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const client = await codexClient()
    try { return await client.request(method, params, timeoutMs) } catch (cause) {
      client.lastError = cause?.message || String(cause)
      lastFailure = cause
      if (cause?.rpcCode !== -32001 || attempt + 1 >= maxAttempts) throw cause
      const backoffMs = Math.min(100 * (2 ** attempt), 1_000) + Math.floor(Math.random() * 75)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, backoffMs))
    }
  }
  throw lastFailure
}
async function codexProtocolManager() {
  requireCodexAccess()
  const root = await workspaceRoot()
  if (!codexProtocolCatalogManager || codexProtocolCatalogRoot !== root) {
    codexProtocolCatalogRoot = root
    codexProtocolCatalogManager = createCodexProtocolCatalog({
      command: process.env.CODEX_GATEWAY_CODEX_COMMAND || '/Applications/ChatGPT.app/Contents/Resources/codex',
      cwd: root,
      env: process.env,
    })
  }
  return codexProtocolCatalogManager
}
async function codexExecutableFingerprint() {
  return await (await codexProtocolManager()).fingerprint()
}
async function installedCodexProtocol() {
  return await (await codexProtocolManager()).load()
}
async function dynamicCodexTools() {
  if (process.env.CODEX_GATEWAY_ENABLE_CODEX !== '1') return []
  const catalog = await installedCodexProtocol()
  return buildDynamicTools(catalog, { readOnlyAnnotations, mutationAnnotations })
}
async function capabilityReport() {
  const enabled = process.env.CODEX_GATEWAY_ENABLE_CODEX === '1'
  const mutationsEnabled = process.env.CODEX_GATEWAY_ALLOW_CODEX_MUTATIONS === '1'
  const [primaryRoot, activeRoot] = await Promise.all([workspaceRoot(), activeWorkspaceRoot()])
  const protocolPromise = enabled
    ? installedCodexProtocol().then((value) => ({ ok: true, value })).catch((cause) => ({ ok: false, cause }))
    : Promise.resolve(null)
  const [skillStatus, xcodeStatus, grants, workspaceCatalog, protocolResult] = await Promise.all([
    searchSkills(primaryRoot, { limit: 1 }),
    xcodeDevelopmentStatus(activeRoot),
    workspaceGrantRoots(),
    discoverWorkspaces(),
    protocolPromise,
  ])

  let protocol = null
  if (protocolResult?.ok) {
    const catalog = protocolResult.value
    protocol = {
      version: catalog.version,
      methodCount: catalog.methodCount,
      schemaHash: catalog.schemaHash,
      experimental: catalog.experimental,
      generatedAt: catalog.generatedAt,
      cacheSource: catalog.cacheSource || null,
      dynamic: true,
    }
  } else if (enabled) {
    protocol = {
      version: null,
      methodCount: 0,
      generatedAt: null,
      dynamic: false,
      error: protocolResult?.cause?.message || String(protocolResult?.cause || 'Codex protocol unavailable'),
    }
  }

  const client = codexAppServers.get(activeRoot) || null
  const available = enabled && protocol?.dynamic === true
  const codexStatus = {
    enabled,
    available,
    connected: Boolean(client?.child),
    connectionState: client?.child ? 'connected' : available ? 'lazy' : 'unavailable',
    toolCount: enabled ? codexTools.length + (protocol?.methodCount || 0) : 0,
    legacyAliasCount: enabled ? codexTools.length : 0,
    mutationsEnabled,
    protocol,
    error: client?.lastError || protocol?.error || null,
  }

  const discoveredWorkspaces = workspaceCatalog.workspaces.slice(0, 100).map(({ name, selector }) => ({ name, selector }))
  return {
    runtime: RUNTIME_IDENTITY,
    connectorCompatibility: {
      workspaceTool: 'workspace_call',
      batchTool: 'workspace_batch',
      cachedToolCallSchemaSupported: true,
      cachedSelectorArgument: '__gatewayWorkspace',
      cachedInvocationExample: { name: 'workspace_info', arguments: { __gatewayWorkspace: '<workspace-selector>' } },
      publicActionContract: {
        expected: ['gateway_info', 'tool_search', 'read_call', 'tool_call', 'tool_batch', 'skill_search', 'skill_read', 'create_goal', 'get_goal', 'update_goal', 'clear_goal'],
        readOnly: ['gateway_info', 'tool_search', 'read_call', 'tool_batch', 'skill_search', 'skill_read', 'get_goal'],
        writeCapable: ['tool_call', 'create_goal', 'update_goal', 'clear_goal'],
        diagnostic: 'If only the readOnly actions are visible to ChatGPT, the host is filtering write-capable MCP actions. Refresh/app action permissions or use a ChatGPT plan/workspace with full MCP write support; do not reclassify mutation routers as read-only.',
      },
    },
    localToolCount: localTools.length,
    workspaceAccess: {
      primaryRoot,
      grants,
      requestScopedSelection: true,
      discoveredCount: workspaceCatalog.workspaces.length,
      discoveredWorkspaces,
    },
    codex: codexStatus,
    discoverableToolCount: localTools.length + codexStatus.toolCount,
    discoverableSkillCount: skillStatus.total,
    persistentWorkspaceGoals: true,
    appleDevelopment: xcodeStatus,
    parity: {
      workspaceFilesSearchGitPatchCommandsAndImages: true,
      codexThreadsHistoryProjectsGoalsAndMutations: available,
    },
    hostOnlyBoundaries: [
      'Codex desktop-window controls such as navigation, opening panels, share links, host handoff, and desktop automations require the interactive desktop host and are not available through the standalone app-server protocol.',
      'ChatGPT web search and image generation are ChatGPT built-ins, not local repository tools.',
      'Third-party Codex app connectors keep host-managed authentication and are not tunneled through this local server.',
    ],
  }
}

async function dispatchLocalTool(name, input = {}) {
  const root = await activeWorkspaceRoot()
  switch (name) {
    case 'capability_report': return structuredResult(await capabilityReport())
    case 'tool_batch': return structuredResult(await runToolBatch(input))
    case 'create_goal': {
      if (typeof input.objective !== 'string' || !input.objective.trim()) throw error('objective is required')
      const existing = await readGoal(root)
      if (existing?.status === 'active') throw error('An active goal already exists. Use get_goal or update_goal.', 'goal_already_active')
      const now = new Date().toISOString()
      return structuredGoalResult(await writeGoal(root, {
        id: randomBytes(12).toString('hex'), workspace: root, objective: input.objective.trim(),
        status: 'active', createdAt: now, updatedAt: now,
        ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
        summary: null, nextSteps: [],
      }))
    }
    case 'get_goal': {
      const goal = await readGoal(root)
      return structuredGoalResult(goal)
    }
    case 'update_goal': {
      const goal = await readGoal(root)
      if (!goal) throw error('No workspace goal exists', 'goal_not_found')
      const statuses = new Set(['active', 'complete', 'blocked'])
      if (!statuses.has(input.status)) throw error('status must be active, complete, or blocked')
      if (input.summary !== undefined && typeof input.summary !== 'string') throw error('summary must be a string')
      if (input.nextSteps !== undefined && (!Array.isArray(input.nextSteps) || input.nextSteps.some((step) => typeof step !== 'string'))) throw error('nextSteps must be an array of strings')
      return structuredGoalResult(await writeGoal(root, {
        ...goal, status: input.status, updatedAt: new Date().toISOString(),
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.nextSteps === undefined ? {} : { nextSteps: input.nextSteps.slice(0, 20) }),
      }))
    }
    case 'clear_goal': {
      const pathname = await goalStatePath(root)
      const previous = await readGoal(root)
      await unlink(pathname).catch((cause) => { if (cause?.code !== 'ENOENT') throw cause })
      return structuredResult({ cleared: Boolean(previous), previousGoalId: previous?.id || null })
    }
    case 'workspace_info': {
      const git = await runProcess('git', ['status', '--short', '--branch'], root)
      return structuredResult({ root, permissionRoot: await workspaceRoot(), grants: await workspaceGrantRoots(), git: { exitCode: git.exitCode, stdout: git.stdout, stderr: git.stderr } })
    }
    case 'runtime_info': return structuredResult({ ...RUNTIME_IDENTITY, primaryRoot: await workspaceRoot(), activeWorkspace: root, grants: await workspaceGrantRoots(), workspaceDispatch: 'workspace_call', cachedConnectorCompatible: true })
    case 'workspace_call':
    case 'workspace_batch': return await dispatchWorkspaceTool(name, input, callTool)
    case 'workspace_list': return structuredResult(await discoverWorkspaces())
    case 'list_files': return structuredResult(await listFiles(root, input))
    case 'read_file': {
      const pathname = await safePath(root, input.path)
      const info = await stat(pathname)
      if (!info.isFile()) throw error('path must refer to a file')
      const maxBytes = Math.min(Math.max(input.maxBytes || 100_000, 1), MAX_FILE_BYTES)
      if (info.size > maxBytes) throw error(`File is ${info.size} bytes; maxBytes limit is ${MAX_FILE_BYTES}`, 'file_too_large')
      const content = await readFile(pathname, 'utf8')
      const lines = content.split('\n')
      const startLine = Math.min(Math.max(input.startLine || 1, 1), Math.max(lines.length, 1))
      const endLine = Math.min(Math.max(input.endLine || lines.length, startLine), lines.length)
      return structuredResult({ path: relative(root, pathname), content: lines.slice(startLine - 1, endLine).join('\n'), bytes: info.size, startLine, endLine, totalLines: lines.length })
    }
    case 'view_image': {
      const pathname = await safePath(root, input.path)
      const info = await stat(pathname)
      const mimeType = IMAGE_TYPES.get(extname(pathname).toLowerCase())
      if (!info.isFile()) throw error('path must refer to a file')
      if (!mimeType) throw error('Supported image formats are PNG, JPEG, GIF, and WebP', 'unsupported_image')
      if (info.size > MAX_IMAGE_BYTES) throw error(`Image exceeds ${MAX_IMAGE_BYTES} bytes`, 'file_too_large')
      return { content: [{ type: 'image', data: (await readFile(pathname)).toString('base64'), mimeType }], structuredContent: { path: relative(root, pathname), bytes: info.size, mimeType }, isError: false }
    }
    case 'search_code': {
      if (typeof input.pattern !== 'string' || !input.pattern) throw error('pattern is required')
      const searchPath = input.path ? relative(root, await safePath(root, input.path)) : '.'
      const args = ['--no-heading', '--line-number', '--color', 'never', '--hidden', '--glob', '!.git/**', '--glob', '!node_modules/**']
      if (input.fixedString === true) args.push('--fixed-strings')
      args.push('--max-count', String(Math.min(Math.max(input.maxMatches || 100, 1), 500)), input.pattern, searchPath || '.')
      const result = await runProcess('rg', args, root, { timeoutMs: 30_000 })
      return structuredResult({ pattern: input.pattern, exitCode: result.exitCode, matches: result.stdout, stderr: result.stderr })
    }
    case 'git_diff': {
      const args = ['diff', '--no-ext-diff', '--unified=3']
      if (input.staged === true) args.push('--cached')
      if (input.path) args.push('--', relative(root, await safePath(root, input.path)))
      const result = await runProcess('git', args, root, { timeoutMs: 30_000 })
      return structuredResult({ exitCode: result.exitCode, diff: result.stdout, stderr: result.stderr })
    }
    case 'replace_in_file': {
      requireWriteConfirmation(input)
      const pathname = await safePath(root, input.path)
      assertSensitiveWriteAllowed(relative(root, pathname))
      const current = await readFile(pathname, 'utf8')
      if (typeof input.find !== 'string' || !input.find) throw error('find is required')
      if (typeof input.replace !== 'string') throw error('replace is required')
      const occurrences = current.split(input.find).length - 1
      if (occurrences !== (input.expectedReplacements ?? 1)) throw error(`Expected ${input.expectedReplacements ?? 1} occurrence(s), found ${occurrences}`, 'replacement_count_mismatch')
      await atomicWrite(pathname, current.replaceAll(input.find, input.replace))
      return structuredResult({ path: relative(root, pathname), replacements: occurrences })
    }
    case 'write_file': {
      requireWriteConfirmation(input)
      const pathname = await safePath(root, input.path, { allowMissing: true })
      assertSensitiveWriteAllowed(relative(root, pathname))
      if (typeof input.content !== 'string') throw error('content is required')
      if (Buffer.byteLength(input.content) > MAX_FILE_BYTES) throw error(`content exceeds ${MAX_FILE_BYTES} bytes`, 'file_too_large')
      await mkdir(dirname(pathname), { recursive: true })
      await atomicWrite(pathname, input.content)
      return structuredResult({ path: relative(root, pathname), bytes: Buffer.byteLength(input.content) })
    }
    case 'apply_patch': {
      requireWriteConfirmation(input)
      await validatePatch(root, input.patch)
      const checked = await runProcess('git', ['apply', '--check', '--whitespace=nowarn', '-'], root, { timeoutMs: 30_000, stdin: input.patch })
      if (checked.exitCode !== 0) throw error(`Patch check failed: ${checked.stderr || checked.stdout}`, 'patch_check_failed')
      const applied = await runProcess('git', ['apply', '--whitespace=nowarn', '-'], root, { timeoutMs: 30_000, stdin: input.patch })
      if (applied.exitCode !== 0) throw error(`Patch apply failed: ${applied.stderr || applied.stdout}`, 'patch_apply_failed')
      return structuredResult({ applied: true, paths: patchPaths(input.patch) })
    }
    case 'exec_readonly': {
      requireCommandAccess()
      if (typeof input.command !== 'string' || !input.command.trim()) throw error('command is required')
      const policy = classifyCommand(input.command, input.args || [])
      if (!policy.readOnly) throw error(`Command is not classified read-only (${policy.risk}). Use exec_command with confirmation=true.`, 'command_not_readonly')
      const cwd = input.cwd ? await safePath(root, input.cwd) : root
      if (!(await stat(cwd)).isDirectory()) throw error('cwd must refer to a directory')
      const session = await startCommandSession(input.command, input.args || [], cwd, input.timeoutMs || 120_000, root)
      await waitForSession(session, Math.min(Math.max(input.yieldTimeMs ?? 10_000, 0), 30_000))
      const result = drainSession(session, Math.min(Math.max(input.maxOutputChars || MAX_RESULT_CHARS, 1), 200_000))
      if (!session.running) commandSessions.delete(session.id)
      return structuredResult({ ...result, commandPolicy: policy })
    }
    case 'exec_command': {
      requireCommandAccess()
      if (typeof input.command !== 'string' || !input.command.trim()) throw error('command is required')
      const policy = classifyCommand(input.command, input.args || [])
      requireCommandConfirmation(input, policy)
      const cwd = input.cwd ? await safePath(root, input.cwd) : root
      if (!(await stat(cwd)).isDirectory()) throw error('cwd must refer to a directory')
      const session = await startCommandSession(input.command, input.args || [], cwd, input.timeoutMs || 120_000, root)
      await waitForSession(session, Math.min(Math.max(input.yieldTimeMs ?? 10_000, 0), 30_000))
      const result = drainSession(session, Math.min(Math.max(input.maxOutputChars || MAX_RESULT_CHARS, 1), 200_000))
      if (!session.running) commandSessions.delete(session.id)
      return structuredResult(result)
    }
    case 'write_stdin': {
      requireCommandAccess()
      const session = commandSessions.get(input.sessionId)
      if (!session) throw error('Unknown or completed sessionId', 'unknown_session')
      if (input.terminate === true && session.running) session.child.kill('SIGTERM')
      if (input.chars !== undefined) {
        if (typeof input.chars !== 'string') throw error('chars must be a string')
        if (!session.running || !session.child.stdin.writable) throw error('Session stdin is closed', 'stdin_closed')
        session.child.stdin.write(input.chars)
      }
      await waitForSession(session, Math.min(Math.max(input.yieldTimeMs ?? 5_000, 0), 30_000))
      const result = drainSession(session, Math.min(Math.max(input.maxOutputChars || MAX_RESULT_CHARS, 1), 200_000))
      if (!session.running) commandSessions.delete(session.id)
      return structuredResult(result)
    }
    case 'codex_list_events': {
      const client = await codexClient()
      return structuredResult(client.listEvents({
        afterSequence: Math.max(input.afterSequence || 0, 0),
        limit: Math.min(Math.max(input.limit || 100, 1), 500),
      }))
    }
    case 'codex_wait_events': {
      const client = await codexClient()
      return structuredResult(await client.waitForEvents(
        Math.max(input.afterSequence || 0, 0),
        Math.min(Math.max(input.timeoutMs || 15_000, 1), 30_000),
      ))
    }
    case 'codex_list_pending_requests': {
      const client = await codexClient()
      return structuredResult({ requests: client.listPendingHostRequests() })
    }
    case 'codex_respond_request': {
      requireCodexMutation(input)
      const client = await codexClient()
      return structuredResult(client.respondHostRequest(input.requestId, { result: input.result, rpcError: input.rpcError }))
    }
    case 'codex_list_threads': {
      const params = {
        limit: Math.min(Math.max(input.limit || 20, 1), 100), cursor: input.cursor ?? null,
        archived: false, searchTerm: input.searchTerm ?? null,
        sortKey: input.sortKey || 'recency_at', sortDirection: input.sortDirection || 'desc',
        useStateDbOnly: input.useStateDbOnly ?? true,
      }
      if (input.cwd === 'workspace') params.cwd = root
      if (input.projectId !== undefined) params.projectId = input.projectId
      return structuredResult(await codexRequest('thread/list', params))
    }
    case 'codex_list_archived_threads': return structuredResult(await codexRequest('thread/list', {
      limit: Math.min(Math.max(input.limit || 20, 1), 100), cursor: input.cursor ?? null,
      archived: true, searchTerm: input.searchTerm ?? null, sortKey: input.sortKey || 'recency_at',
      sortDirection: input.sortDirection || 'desc', useStateDbOnly: input.useStateDbOnly ?? true,
    }))
    case 'codex_search_threads': return structuredResult(await codexRequest('thread/search', {
      searchTerm: input.searchTerm, archived: input.archived ?? false,
      limit: Math.min(Math.max(input.limit || 20, 1), 100), cursor: input.cursor ?? null,
      sortKey: input.sortKey || 'recency_at', sortDirection: input.sortDirection || 'desc',
    }))
    case 'codex_read_thread': {
      const thread = await codexRequest('thread/read', { threadId: input.threadId, includeTurns: false })
      const turns = input.turnLimit === 0 ? null : await codexRequest('thread/turns/list', {
        threadId: input.threadId, cursor: input.cursor ?? null,
        limit: Math.min(Math.max(input.turnLimit || 20, 1), 50),
        sortDirection: input.sortDirection || 'desc', itemsView: input.includeOutputs === true ? 'full' : 'summary',
      })
      return structuredResult({ ...thread, turnsPage: turns })
    }
    case 'codex_list_thread_turns': return structuredResult(await codexRequest('thread/turns/list', {
      threadId: input.threadId, cursor: input.cursor ?? null,
      limit: Math.min(Math.max(input.limit || 20, 1), 50), sortDirection: input.sortDirection || 'desc',
      itemsView: input.includeOutputs === true ? 'full' : (input.itemsView || 'summary'),
    }))
    case 'codex_list_projects': return structuredResult(await codexRequest('project/list', {
      limit: Math.min(Math.max(input.limit || 50, 1), 100), cursor: input.cursor ?? null,
    }))
    case 'codex_read_project': return structuredResult(await codexRequest('project/read', { projectId: input.projectId }))
    case 'codex_get_goal': return structuredResult(await codexRequest('thread/goal/get', { threadId: input.threadId }))
    case 'codex_list_background_terminals': return structuredResult(await codexRequest('thread/backgroundTerminals/list', {
      threadId: input.threadId, limit: Math.min(Math.max(input.limit || 20, 1), 100), cursor: input.cursor ?? null,
    }))
    case 'codex_create_thread': {
      requireCodexMutation(input)
      const created = await codexRequest('thread/start', {
        cwd: root, runtimeWorkspaceRoots: [root], projectId: input.projectId ?? null,
        model: input.model ?? null, sandbox: input.sandbox || 'workspace-write', approvalPolicy: input.approvalPolicy || 'never',
      })
      if (!input.prompt) return structuredResult(created)
      const threadId = created?.thread?.id || created?.thread?.sessionId
      const turn = await codexRequest('turn/start', {
        threadId, input: [{ type: 'text', text: input.prompt }], model: input.model ?? null, effort: input.effort ?? null,
        cwd: root, runtimeWorkspaceRoots: [root],
      })
      return structuredResult({ ...created, turn })
    }
    case 'codex_send_message_to_thread': {
      requireCodexMutation(input)
      await codexRequest('thread/resume', { threadId: input.threadId, excludeTurns: true })
      return structuredResult(await codexRequest('turn/start', {
        threadId: input.threadId, input: [{ type: 'text', text: input.prompt }],
        model: input.model ?? null, effort: input.effort ?? null,
      }))
    }
    case 'codex_fork_thread': {
      requireCodexMutation(input)
      return structuredResult(await codexRequest('thread/fork', {
        threadId: input.threadId, lastTurnId: input.lastTurnId ?? null,
        model: input.model ?? null, cwd: root, runtimeWorkspaceRoots: [root], excludeTurns: input.excludeTurns ?? true,
      }))
    }
    case 'codex_set_thread_archived': {
      requireCodexMutation(input)
      return structuredResult(await codexRequest(input.archived ? 'thread/archive' : 'thread/unarchive', { threadId: input.threadId }))
    }
    case 'codex_set_thread_title': {
      requireCodexMutation(input)
      return structuredResult(await codexRequest('thread/name/set', { threadId: input.threadId, name: input.title }))
    }
    case 'codex_create_goal': {
      requireCodexMutation(input)
      return structuredResult(await codexRequest('thread/goal/set', {
        threadId: input.threadId, objective: input.objective,
        status: 'active', ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
      }))
    }
    case 'codex_update_goal': {
      requireCodexMutation(input)
      return structuredResult(await codexRequest('thread/goal/set', { threadId: input.threadId, status: input.status }))
    }
    case 'codex_clear_goal': {
      requireCodexMutation(input)
      return structuredResult(await codexRequest('thread/goal/clear', { threadId: input.threadId }))
    }
    case 'codex_interrupt_turn': {
      requireCodexMutation(input)
      return structuredResult(await codexRequest('turn/interrupt', { threadId: input.threadId, turnId: input.turnId }))
    }
    default: throw error(`Unknown local tool: ${name}`, 'unknown_tool')
  }
}

const emptySchema = { type: 'object', properties: {}, additionalProperties: false }
const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
const mutationAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
const goalMutationAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
const localTools = [
  ...workspaceDispatchTools({ readOnlyAnnotations, mutationAnnotations }),
  { name: 'runtime_info', description: 'Read the identity of the executing Gateway process, loaded source fingerprint, granted roots, and cached-connector workspace dispatch support.', inputSchema: emptySchema, annotations: readOnlyAnnotations },
  { name: 'capability_report', description: 'Report every exposed tool group and the Codex host-only boundaries.', inputSchema: emptySchema, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'tool_batch', description: 'Run up to 16 independent read-only discovered tools concurrently.', inputSchema: { type: 'object', properties: { calls: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, required: ['name'], additionalProperties: false } } }, required: ['calls'], additionalProperties: false }, annotations: readOnlyAnnotations },
  { name: 'create_goal', description: 'Create a persistent goal for this workspace. Fails while another goal is active.', inputSchema: { type: 'object', properties: { objective: { type: 'string', minLength: 1 }, tokenBudget: { type: 'integer', minimum: 1 } }, required: ['objective'], additionalProperties: false }, annotations: goalMutationAnnotations },
  { name: 'get_goal', description: 'Read the persistent goal for this workspace, including its latest checkpoint.', inputSchema: emptySchema, annotations: readOnlyAnnotations },
  { name: 'update_goal', description: 'Update the current workspace goal status and checkpoint.', inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['active', 'complete', 'blocked'] }, summary: { type: 'string' }, nextSteps: { type: 'array', items: { type: 'string' }, maxItems: 20 } }, required: ['status'], additionalProperties: false }, annotations: goalMutationAnnotations },
  { name: 'clear_goal', description: 'Remove the persistent goal for this workspace.', inputSchema: emptySchema, annotations: mutationAnnotations },
  { name: 'workspace_info', description: 'Read the active workspace root, configured grants, and git status.', inputSchema: emptySchema, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'workspace_list', description: 'Discover Git workspaces inside the configured workspace grants.', inputSchema: emptySchema, annotations: readOnlyAnnotations },
  { name: 'list_files', description: 'List workspace files and directories with deterministic cursor pagination and bounded recursion depth.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, maxEntries: { type: 'integer', minimum: 1, maximum: 2000 }, cursor: { type: 'string' }, maxDepth: { type: 'integer', minimum: 0, maximum: 50 } }, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'read_file', description: 'Read a complete or line-bounded UTF-8 workspace file.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, maxBytes: { type: 'integer', minimum: 1, maximum: MAX_FILE_BYTES }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } }, required: ['path'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'view_image', description: 'Read a workspace image as MCP image content.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'search_code', description: 'Search source text with ripgrep.', inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, fixedString: { type: 'boolean' }, maxMatches: { type: 'integer', minimum: 1, maximum: 500 } }, required: ['pattern'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'git_diff', description: 'Read the unstaged or staged git diff.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, staged: { type: 'boolean' } }, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'replace_in_file', description: 'Replace exact text. Requires write opt-in and confirmation=true.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' }, expectedReplacements: { type: 'integer', minimum: 1 }, confirmation: { type: 'boolean' } }, required: ['path', 'find', 'replace', 'confirmation'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  { name: 'write_file', description: 'Create or replace a UTF-8 file. Requires write opt-in and confirmation=true.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, confirmation: { type: 'boolean' } }, required: ['path', 'content', 'confirmation'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  { name: 'apply_patch', description: 'Validate and apply a unified git patch. Requires write opt-in and confirmation=true.', inputSchema: { type: 'object', properties: { patch: { type: 'string' }, confirmation: { type: 'boolean' } }, required: ['patch', 'confirmation'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  { name: 'exec_readonly', description: 'Run a command only when its executable and arguments match the Gateway read-only policy. Safe for parallel batches.', inputSchema: { type: 'object', properties: { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1, maximum: 300000 }, yieldTimeMs: { type: 'integer', minimum: 0, maximum: 30000 }, maxOutputChars: { type: 'integer', minimum: 1, maximum: 200000 } }, required: ['command'], additionalProperties: false }, annotations: readOnlyAnnotations },
  { name: 'exec_command', description: 'Run an allowlisted executable without a shell. Mutation-capable or general-purpose commands require confirmation=true. Long commands return a sessionId.', inputSchema: { type: 'object', properties: { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1, maximum: 300000 }, yieldTimeMs: { type: 'integer', minimum: 0, maximum: 30000 }, maxOutputChars: { type: 'integer', minimum: 1, maximum: 200000 }, confirmation: { type: 'boolean' } }, required: ['command'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  { name: 'write_stdin', description: 'Write to, poll, or terminate an exec_command session.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, chars: { type: 'string' }, terminate: { type: 'boolean' }, yieldTimeMs: { type: 'integer', minimum: 0, maximum: 30000 }, maxOutputChars: { type: 'integer', minimum: 1, maximum: 200000 } }, required: ['sessionId'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
]
const codexPagingProperties = {
  cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 },
  sortDirection: { type: 'string', enum: ['asc', 'desc'] },
}
const codexTools = [
  { name: 'codex_list_events', description: 'Read buffered Codex app-server notifications and server requests for the active workspace.', inputSchema: { type: 'object', properties: { afterSequence: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500 } }, additionalProperties: false }, annotations: readOnlyAnnotations },
  { name: 'codex_wait_events', description: 'Wait briefly for new Codex app-server events in the active workspace.', inputSchema: { type: 'object', properties: { afterSequence: { type: 'integer', minimum: 0 }, timeoutMs: { type: 'integer', minimum: 1, maximum: 30000 } }, additionalProperties: false }, annotations: readOnlyAnnotations },
  { name: 'codex_list_pending_requests', description: 'List Codex app-server requests awaiting a host response, including approvals and interactive requests.', inputSchema: emptySchema, annotations: readOnlyAnnotations },
  { name: 'codex_respond_request', description: 'Respond to one pending Codex app-server host request. Requires Codex mutation opt-in and confirmation=true.', inputSchema: { type: 'object', properties: { requestId: { type: 'string' }, result: { type: 'object', additionalProperties: true }, rpcError: { type: 'object', properties: { code: { type: 'integer' }, message: { type: 'string' }, data: {} }, required: ['code', 'message'], additionalProperties: true }, confirmation: { type: 'boolean' } }, required: ['requestId', 'confirmation'], additionalProperties: false }, annotations: mutationAnnotations },
  { name: 'codex_list_threads', description: 'List local Codex tasks/threads from the Codex app-server, including titles, status, project, workspace, and pagination.', inputSchema: { type: 'object', properties: { ...codexPagingProperties, searchTerm: { type: 'string' }, cwd: { type: 'string', enum: ['all', 'workspace'] }, projectId: { type: ['string', 'null'] }, sortKey: { type: 'string', enum: ['created_at', 'updated_at', 'recency_at', 'section_position'] }, useStateDbOnly: { type: 'boolean' } }, additionalProperties: false }, annotations: readOnlyAnnotations },
  { name: 'codex_list_archived_threads', description: 'List archived local Codex tasks/threads with pagination.', inputSchema: { type: 'object', properties: { ...codexPagingProperties, searchTerm: { type: 'string' }, sortKey: { type: 'string', enum: ['created_at', 'updated_at', 'recency_at', 'section_position'] }, useStateDbOnly: { type: 'boolean' } }, additionalProperties: false }, annotations: readOnlyAnnotations },
  { name: 'codex_search_threads', description: 'Full-text search local Codex task/thread history.', inputSchema: { type: 'object', properties: { ...codexPagingProperties, searchTerm: { type: 'string' }, archived: { type: 'boolean' }, sortKey: { type: 'string', enum: ['created_at', 'updated_at', 'recency_at'] } }, required: ['searchTerm'], additionalProperties: false }, annotations: readOnlyAnnotations },
  { name: 'codex_read_thread', description: 'Read a Codex task/thread plus a bounded page of its message/turn history. includeOutputs=true returns all persisted turn items.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, turnLimit: { type: 'integer', minimum: 0, maximum: 50 }, cursor: { type: 'string' }, sortDirection: { type: 'string', enum: ['asc', 'desc'] }, includeOutputs: { type: 'boolean' } }, required: ['threadId'], additionalProperties: false }, annotations: readOnlyAnnotations },
  { name: 'codex_list_thread_turns', description: 'Page through the complete persisted message/turn history of a Codex task.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 }, sortDirection: { type: 'string', enum: ['asc', 'desc'] }, itemsView: { type: 'string', enum: ['notLoaded', 'summary', 'full'] }, includeOutputs: { type: 'boolean' } }, required: ['threadId'], additionalProperties: false }, annotations: readOnlyAnnotations },
  { name: 'codex_list_projects', description: 'List Codex projects with pagination.', inputSchema: { type: 'object', properties: codexPagingProperties, additionalProperties: false }, annotations: readOnlyAnnotations },
  { name: 'codex_read_project', description: 'Read one Codex project.', inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'], additionalProperties: false }, annotations: readOnlyAnnotations },
  { name: 'codex_get_goal', description: 'Read the active goal, status, budget, and usage for a Codex task/thread.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' } }, required: ['threadId'], additionalProperties: false }, annotations: readOnlyAnnotations },
  { name: 'codex_list_background_terminals', description: 'List background terminals owned by a Codex task/thread.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['threadId'], additionalProperties: false }, annotations: readOnlyAnnotations },
  { name: 'codex_create_thread', description: 'Create a Codex task in this workspace and optionally start its first turn. Can spend model usage. Requires Codex mutation opt-in and confirmation=true.', inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, projectId: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] }, approvalPolicy: { type: 'string', enum: ['untrusted', 'on-request', 'never'] }, confirmation: { type: 'boolean' } }, required: ['confirmation'], additionalProperties: false }, annotations: mutationAnnotations },
  { name: 'codex_send_message_to_thread', description: 'Send a prompt as a new turn to an existing local Codex task. Can spend model usage and change files. Requires Codex mutation opt-in and confirmation=true.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, prompt: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, confirmation: { type: 'boolean' } }, required: ['threadId', 'prompt', 'confirmation'], additionalProperties: false }, annotations: mutationAnnotations },
  { name: 'codex_fork_thread', description: 'Fork a Codex task through an optional turn. Requires Codex mutation opt-in and confirmation=true.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, lastTurnId: { type: 'string' }, model: { type: 'string' }, excludeTurns: { type: 'boolean' }, confirmation: { type: 'boolean' } }, required: ['threadId', 'confirmation'], additionalProperties: false }, annotations: mutationAnnotations },
  { name: 'codex_set_thread_archived', description: 'Archive or unarchive a Codex task. Requires Codex mutation opt-in and confirmation=true.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, archived: { type: 'boolean' }, confirmation: { type: 'boolean' } }, required: ['threadId', 'archived', 'confirmation'], additionalProperties: false }, annotations: mutationAnnotations },
  { name: 'codex_set_thread_title', description: 'Rename a Codex task. Requires Codex mutation opt-in and confirmation=true.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, title: { type: 'string' }, confirmation: { type: 'boolean' } }, required: ['threadId', 'title', 'confirmation'], additionalProperties: false }, annotations: mutationAnnotations },
  { name: 'codex_create_goal', description: 'Create an active goal for a Codex task/thread. Set tokenBudget only when the user explicitly requests a budget. Requires Codex mutation opt-in and confirmation=true.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, objective: { type: 'string', minLength: 1 }, tokenBudget: { type: 'integer', minimum: 1 }, confirmation: { type: 'boolean' } }, required: ['threadId', 'objective', 'confirmation'], additionalProperties: false }, annotations: mutationAnnotations },
  { name: 'codex_update_goal', description: 'Mark an existing Codex task goal complete or blocked. Requires Codex mutation opt-in and confirmation=true.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, status: { type: 'string', enum: ['complete', 'blocked'] }, confirmation: { type: 'boolean' } }, required: ['threadId', 'status', 'confirmation'], additionalProperties: false }, annotations: mutationAnnotations },
  { name: 'codex_clear_goal', description: 'Remove the goal from a Codex task/thread. Requires Codex mutation opt-in and confirmation=true.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, confirmation: { type: 'boolean' } }, required: ['threadId', 'confirmation'], additionalProperties: false }, annotations: mutationAnnotations },
  { name: 'codex_interrupt_turn', description: 'Interrupt an active Codex turn. Requires Codex mutation opt-in and confirmation=true.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, turnId: { type: 'string' }, confirmation: { type: 'boolean' } }, required: ['threadId', 'turnId', 'confirmation'], additionalProperties: false }, annotations: mutationAnnotations },
]
async function allTools() {
  if (process.env.CODEX_GATEWAY_ENABLE_CODEX !== '1') return localTools
  let dynamic = []
  try { dynamic = await dynamicCodexTools() } catch {}
  return [localTools, codexTools, dynamic].flat()
}
async function runToolBatch(input) {
  if (!Array.isArray(input.calls) || input.calls.length < 1 || input.calls.length > 16) throw error('calls must contain between 1 and 16 entries')
  const tools = await allTools()
  const catalog = new Map(tools.map((tool) => [tool.name, tool]))
  const calls = input.calls.map((entry, index) => {
    if (!entry || typeof entry.name !== 'string' || !entry.name) throw error(`calls[${index}].name is required`)
    if (entry.name === 'tool_batch') throw error('tool_batch cannot invoke itself', 'recursive_gateway_call')
    const tool = catalog.get(entry.name)
    if (!tool) throw error(`Unknown tool: ${entry.name}`, 'unknown_tool')
    if (tool.annotations?.readOnlyHint !== true) throw error(`tool_batch accepts read-only tools only: ${entry.name}`, 'batch_mutation_blocked')
    if (entry.name === 'view_image') throw error('Use tool_call for view_image so image content is preserved.', 'batch_media_unsupported')
    return { name: entry.name, arguments: entry.arguments || {} }
  })
  const results = await Promise.all(calls.map(async (entry, index) => {
    try {
      const result = await callTool(entry.name, entry.arguments)
      const value = result?.structuredContent ?? result?.content?.filter((item) => item.type === 'text').map((item) => item.text).join('\n') ?? null
      return { index, name: entry.name, ok: result?.isError !== true, result: value }
    } catch (cause) {
      return { index, name: entry.name, ok: false, error: { code: cause?.code || 'tool_error', message: cause?.message || String(cause) } }
    }
  }))
  return { parallel: true, count: results.length, results }
}
async function callTool(name, args, context = {}) {
  if (context.workspace !== undefined) {
    const root = await selectedWorkspaceRoot(context.workspace)
    return await workspaceContext.run({ root }, async () => await callTool(name, args))
  }
  if (localTools.some((tool) => tool.name === name) || codexTools.some((tool) => tool.name === name)) return await dispatchLocalTool(name, args)
  if (process.env.CODEX_GATEWAY_ENABLE_CODEX === '1') {
    const dynamic = (await dynamicCodexTools()).find((tool) => tool.name === name)
    if (dynamic) {
      const metadata = dynamic.codexProtocol
      if (!metadata.readOnly) requireCodexMutation(args, metadata.confirmationField)
      const rawParams = { ...(args || {}) }
      if (metadata.confirmationField) delete rawParams[metadata.confirmationField]
      const params = Object.prototype.hasOwnProperty.call(rawParams, 'params') && Object.keys(rawParams).length === 1 ? rawParams.params : rawParams
      const requestParams = metadata.paramsMode === 'optional' && (!params || !Object.keys(params).length) ? null : params
      await enforceDynamicCodexWorkspace(metadata.method, requestParams, await activeWorkspaceRoot())
      return structuredResult(await codexRequest(metadata.method, requestParams))
    }
  }
  throw error(`Unknown tool: ${name}`, 'unknown_tool')
}

// Keep schemas out of the default connector context. Tools and skills are loaded
// only after an explicit task-scoped search.
const { gatewayTools, callGatewayTool } = createGateway({
  localTools, emptySchema, readOnlyAnnotations, mutationAnnotations,
  capabilityReport, allTools, callTool,
  searchSkills: async (input) => {
    const { workspace, ...skillInput } = input || {}
    return await searchSkills(await selectedWorkspaceRoot(workspace), skillInput)
  },
  readSkill: async (input) => {
    const { workspace, ...skillInput } = input || {}
    return await readSkill(await selectedWorkspaceRoot(workspace), skillInput)
  },
  structuredResult, error,
})

const rpcResponse = (id, result) => ({ jsonrpc: '2.0', id, result })
const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })
async function handleRpc(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(message?.id ?? null, -32600, 'Invalid JSON-RPC request')
  if (message.id === undefined) return null
  process.stderr.write(`[codex-gateway] MCP request method=${message.method}\n`)
  try {
    switch (message.method) {
      case 'initialize': {
        const requested = message.params?.protocolVersion
        return rpcResponse(message.id, {
          protocolVersion: SUPPORTED_VERSIONS.has(requested) ? requested : MCP_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'codex-gateway', version: GATEWAY_VERSION },
          instructions: 'Search tools or skills only when the task needs them. For workspace selection, discover workspace_list and workspace_call. Cached connectors can call tool_call(name=workspace_call, arguments={workspace, name, arguments}) without a top-level workspace field. Never change the global workspace for a request. Invoke one exact result with tool_call, or use tool_batch for independent read-only calls that can run concurrently. Keep mutations and dependent steps sequential. Load skill instructions progressively with skill_read. For Apple development, load the xcodebuildmcp-cli skill and run the installed xcodebuildmcp executable through exec_command; use its help-first device or simulator workflows instead of declaring the build unavailable. For multi-step Web work, use the workspace goal tools. While a goal is active, continue within the current assistant turn after each tool result, save checkpoints, and stop only when complete or genuinely blocked. Local policy and confirmations remain authoritative.',
        })
      }
      case 'ping': return rpcResponse(message.id, {})
      case 'tools/list': return rpcResponse(message.id, { tools: gatewayTools })
      case 'tools/call': return rpcResponse(message.id, await callGatewayTool(message.params?.name, message.params?.arguments || {}))
      case 'resources/list': return rpcResponse(message.id, { resources: [] })
      case 'logging/setLevel': return rpcResponse(message.id, {})
      default: return rpcError(message.id, -32601, `Method not found: ${message.method}`)
    }
  } catch (cause) {
    return rpcResponse(message.id, structuredErrorResult(cause))
  }
}

async function startStdio() {
  process.stderr.write(`[codex-gateway] stdio workspace=${await workspaceRoot()}\n`)
  process.stdin.setEncoding('utf8')
  let pending = ''
  let processing = Promise.resolve()
  process.stdin.on('data', (chunk) => {
    pending += chunk
    const messages = []
    pending = parseJsonLines(pending, (message) => messages.push(message), (line, cause) => {
      process.stderr.write(`[codex-gateway] invalid JSON: ${cause.message}; line=${line.slice(0, 500)}\n`)
    })
    processing = processing.then(async () => {
      for (const message of messages) {
        const response = await handleRpc(message)
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
      }
    })
  })
}
const bearerToken = (request) => (request.headers.authorization || '').startsWith('Bearer ') ? request.headers.authorization.slice(7).trim() : ''
async function startHttp(port, host) {
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  if (!loopback && process.env.CODEX_GATEWAY_ALLOW_NONLOCAL_BIND !== '1') throw error('HTTP mode is loopback-only by default', 'nonlocal_bind_blocked')
  const token = process.env.CODEX_GATEWAY_TOKEN || randomBytes(24).toString('hex')
  if (!process.env.CODEX_GATEWAY_TOKEN) process.stderr.write(`[codex-gateway] generated token: ${token}\n`)
  process.stderr.write(`[codex-gateway] HTTP MCP listening on http://${host}:${port}/mcp\n`)
  createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', request.headers.origin || '*')
    response.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, mcp-session-id, mcp-protocol-version')
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return }
    if (request.url === '/health' && request.method === 'GET') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true,"service":"codex-gateway"}'); return }
    if (request.url !== '/mcp') { response.writeHead(404); response.end('Not found'); return }
    if (!token || bearerToken(request) !== token) { response.writeHead(401, { 'www-authenticate': 'Bearer' }); response.end('Unauthorized'); return }
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }); response.end('Use POST'); return }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk; if (Buffer.byteLength(body) > MAX_FILE_BYTES) request.destroy() })
    request.on('end', async () => {
      try {
        const payload = JSON.parse(body)
        const result = Array.isArray(payload) ? (await Promise.all(payload.map(handleRpc))).filter(Boolean) : await handleRpc(payload)
        if (result === null || (Array.isArray(result) && !result.length)) { response.writeHead(202); response.end(); return }
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' })
        response.end(JSON.stringify(result))
      } catch (cause) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify(rpcError(null, -32700, cause?.message || String(cause))))
      }
    })
  }).listen(port, host)
}
function shutdown() {
  for (const session of commandSessions.values()) if (session.running) session.child.kill('SIGTERM')
  for (const client of codexAppServers.values()) client.close()
  codexAppServers.clear()
}
process.once('SIGINT', () => { shutdown(); process.exit(0) })
process.once('SIGTERM', () => { shutdown(); process.exit(0) })

const args = process.argv.slice(2)
const transport = args.includes('--transport') ? args[args.indexOf('--transport') + 1] : 'stdio'
if (transport === 'http') {
  const port = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : (process.env.CODEX_GATEWAY_PORT || 8787))
  const host = args.includes('--host') ? args[args.indexOf('--host') + 1] : (process.env.CODEX_GATEWAY_HOST || '127.0.0.1')
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('port must be between 1 and 65535')
  await startHttp(port, host)
} else if (transport === 'stdio') await startStdio()
else throw new Error(`Unsupported transport: ${transport}`)

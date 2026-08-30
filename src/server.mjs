#!/usr/bin/env bun

import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createGateway } from './gateway-tools.mjs'
import { createStructuredResult } from './result-bounds.mjs'
import { readSkill, searchSkills } from './skill-catalog.mjs'

const MCP_VERSION = '2025-11-25'
const SUPPORTED_VERSIONS = new Set([MCP_VERSION, '2025-06-18', '2024-11-05'])
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_RESULT_CHARS = 40_000
const MAX_SESSION_CHARS = 1_000_000
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.turbo', 'DerivedData', 'build', 'dist'])
const DEFAULT_COMMANDS = new Set(['git', 'npm', 'npx', 'node', 'pnpm', 'rg', 'sed', 'swift', 'swiftformat'])
const IMAGE_TYPES = new Map([
  ['.gif', 'image/gif'], ['.jpeg', 'image/jpeg'], ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'], ['.webp', 'image/webp'],
])
const commandSessions = new Map()
let codexAppServer

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
function assertInside(root, candidate) {
  const relation = relative(root, candidate)
  if (relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))) return candidate
  throw error('Path must stay inside the configured workspace root', 'path_outside_workspace')
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
  const sensitive = value === '.env' || value.startsWith('.env.') || value.includes('/.env') || value.includes('credentials') || value.includes('secrets')
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
function requireCodexMutation(input) {
  requireCodexAccess()
  if (process.env.CODEX_GATEWAY_ALLOW_CODEX_MUTATIONS !== '1') throw error('Codex mutation tools are disabled. Set CODEX_GATEWAY_ALLOW_CODEX_MUTATIONS=1.', 'codex_mutations_disabled')
  if (input?.confirmation !== true) throw error('Set confirmation=true after reviewing the exact Codex action.', 'confirmation_required')
}
function commandAllowlist() {
  const configured = process.env.CODEX_GATEWAY_COMMAND_ALLOWLIST?.split(',').map((item) => item.trim()).filter(Boolean)
  return new Set(configured?.length ? configured : DEFAULT_COMMANDS)
}
function validateCommand(command, args, timeoutMs) {
  const executable = command.split(/[\\/]/).at(-1)
  if (!executable || !commandAllowlist().has(executable)) throw error(`Command is not allowlisted: ${command}`, 'command_not_allowed')
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw error('args must be an array of strings')
  if (process.env.CODEX_GATEWAY_ALLOW_EXTERNAL_PATHS !== '1') {
    for (const arg of args) {
      if (isAbsolute(arg) || arg === '..' || arg.startsWith(`..${sep}`) || arg.includes(`${sep}..${sep}`)) {
        throw error('Command arguments may not address paths outside the workspace root', 'external_path_blocked')
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

async function runProcess(command, args, cwd, { timeoutMs = 120_000, stdin } = {}) {
  validateCommand(command, args, timeoutMs)
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, env: process.env, shell: false })
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
function startCommandSession(command, args, cwd, timeoutMs) {
  validateCommand(command, args, timeoutMs)
  const child = spawn(command, args, { cwd, env: process.env, shell: false })
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
  const entries = []
  async function visit(directory) {
    if (entries.length >= maxEntries) return
    const children = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const child of children) {
      if (entries.length >= maxEntries) return
      if (child.isDirectory() && IGNORED_DIRS.has(child.name)) continue
      const full = join(directory, child.name)
      entries.push({ path: relative(root, full), type: child.isDirectory() ? 'directory' : 'file' })
      if (child.isDirectory()) await visit(full)
    }
  }
  await visit(start)
  return { root, path: relative(root, start) || '.', truncated: entries.length >= maxEntries, entries }
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
    const child = spawn(command, ['app-server', '--listen', 'stdio://'], { cwd: this.root, env: process.env, shell: false })
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
      await this.request('initialize', {
        clientInfo: { name: 'codex-gateway', title: 'Codex Gateway', version: '0.2.0' },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      }, 30_000)
      this.notify('initialized', {})
      process.stderr.write('[codex-gateway:codex] connected\n')
    } catch (cause) {
      this.close()
      throw cause
    }
  }
  #onMessage(message) {
    if (message?.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timeout)
      if (message.error) pending.reject(error(message.error.message || json(message.error), 'codex_request_failed'))
      else pending.resolve(message.result)
      return
    }
    if (message?.id !== undefined && typeof message.method === 'string') {
      this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Interactive host request unavailable through the local MCP bridge' } })}\n`)
    }
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
  }
}
async function codexClient() {
  requireCodexAccess()
  const root = await workspaceRoot()
  if (!codexAppServer || codexAppServer.root !== root) {
    codexAppServer?.close()
    codexAppServer = new CodexAppServerClient(root)
  }
  await codexAppServer.start()
  return codexAppServer
}
async function codexRequest(method, params = {}, timeoutMs) {
  const client = await codexClient()
  try { return await client.request(method, params, timeoutMs) } catch (cause) {
    client.lastError = cause?.message || String(cause)
    throw cause
  }
}
async function capabilityReport() {
  let codexStatus = { enabled: process.env.CODEX_GATEWAY_ENABLE_CODEX === '1', connected: false, toolCount: 0, mutationsEnabled: process.env.CODEX_GATEWAY_ALLOW_CODEX_MUTATIONS === '1', error: null }
  if (codexStatus.enabled) {
    try {
      await codexClient()
      codexStatus = { ...codexStatus, connected: Boolean(codexAppServer?.child), toolCount: codexTools.length, error: codexAppServer?.lastError }
    } catch (cause) { codexStatus.error = cause?.message || String(cause) }
  }
  const skillStatus = await searchSkills(await workspaceRoot(), { limit: 1 })
  return {
    localToolCount: localTools.length,
    codex: codexStatus,
    discoverableToolCount: localTools.length + codexStatus.toolCount,
    discoverableSkillCount: skillStatus.total,
    parity: {
      workspaceFilesSearchGitPatchCommandsAndImages: true,
      codexThreadsHistoryProjectsGoalsAndMutations: codexStatus.connected,
    },
    hostOnlyBoundaries: [
      'Codex desktop-window controls such as navigation, opening panels, share links, host handoff, and desktop automations require the interactive desktop host and are not available through the standalone app-server protocol.',
      'ChatGPT web search and image generation are ChatGPT built-ins, not local repository tools.',
      'Third-party Codex app connectors keep host-managed authentication and are not tunneled through this local server.',
    ],
  }
}

async function dispatchLocalTool(name, input = {}) {
  const root = await workspaceRoot()
  switch (name) {
    case 'capability_report': return structuredResult(await capabilityReport())
    case 'workspace_info': {
      const git = await runProcess('git', ['status', '--short', '--branch'], root)
      return structuredResult({ root, git: { exitCode: git.exitCode, stdout: git.stdout, stderr: git.stderr } })
    }
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
    case 'exec_command': {
      requireCommandAccess()
      if (typeof input.command !== 'string' || !input.command.trim()) throw error('command is required')
      const cwd = input.cwd ? await safePath(root, input.cwd) : root
      if (!(await stat(cwd)).isDirectory()) throw error('cwd must refer to a directory')
      const session = startCommandSession(input.command, input.args || [], cwd, input.timeoutMs || 120_000)
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
    case 'get_goal': return structuredResult(await codexRequest('thread/goal/get', { threadId: input.threadId }))
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
    case 'create_goal': {
      requireCodexMutation(input)
      return structuredResult(await codexRequest('thread/goal/set', {
        threadId: input.threadId, objective: input.objective,
        status: 'active', ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
      }))
    }
    case 'update_goal': {
      requireCodexMutation(input)
      return structuredResult(await codexRequest('thread/goal/set', { threadId: input.threadId, status: input.status }))
    }
    case 'clear_goal': {
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
const localTools = [
  { name: 'capability_report', description: 'Report every exposed tool group and the Codex host-only boundaries.', inputSchema: emptySchema, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'workspace_info', description: 'Read the workspace root and git status.', inputSchema: emptySchema, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'list_files', description: 'List workspace files and directories.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, maxEntries: { type: 'integer', minimum: 1, maximum: 2000 } }, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'read_file', description: 'Read a complete or line-bounded UTF-8 workspace file.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, maxBytes: { type: 'integer', minimum: 1, maximum: MAX_FILE_BYTES }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } }, required: ['path'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'view_image', description: 'Read a workspace image as MCP image content.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'search_code', description: 'Search source text with ripgrep.', inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, fixedString: { type: 'boolean' }, maxMatches: { type: 'integer', minimum: 1, maximum: 500 } }, required: ['pattern'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'git_diff', description: 'Read the unstaged or staged git diff.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, staged: { type: 'boolean' } }, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'replace_in_file', description: 'Replace exact text. Requires write opt-in and confirmation=true.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' }, expectedReplacements: { type: 'integer', minimum: 1 }, confirmation: { type: 'boolean' } }, required: ['path', 'find', 'replace', 'confirmation'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  { name: 'write_file', description: 'Create or replace a UTF-8 file. Requires write opt-in and confirmation=true.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, confirmation: { type: 'boolean' } }, required: ['path', 'content', 'confirmation'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  { name: 'apply_patch', description: 'Validate and apply a unified git patch. Requires write opt-in and confirmation=true.', inputSchema: { type: 'object', properties: { patch: { type: 'string' }, confirmation: { type: 'boolean' } }, required: ['patch', 'confirmation'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  { name: 'exec_command', description: 'Run an allowlisted executable without a shell. Long commands return a sessionId.', inputSchema: { type: 'object', properties: { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1, maximum: 300000 }, yieldTimeMs: { type: 'integer', minimum: 0, maximum: 30000 }, maxOutputChars: { type: 'integer', minimum: 1, maximum: 200000 } }, required: ['command'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  { name: 'write_stdin', description: 'Write to, poll, or terminate an exec_command session.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, chars: { type: 'string' }, terminate: { type: 'boolean' }, yieldTimeMs: { type: 'integer', minimum: 0, maximum: 30000 }, maxOutputChars: { type: 'integer', minimum: 1, maximum: 200000 } }, required: ['sessionId'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
]
const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
const mutationAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
const codexPagingProperties = {
  cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 },
  sortDirection: { type: 'string', enum: ['asc', 'desc'] },
}
const codexTools = [
  { name: 'codex_list_threads', description: 'List local Codex tasks/threads from the Codex app-server, including titles, status, project, workspace, and pagination.', inputSchema: { type: 'object', properties: { ...codexPagingProperties, searchTerm: { type: 'string' }, cwd: { type: 'string', enum: ['all', 'workspace'] }, projectId: { type: ['string', 'null'] }, sortKey: { type: 'string', enum: ['created_at', 'updated_at', 'recency_at', 'section_position'] }, useStateDbOnly: { type: 'boolean' } }, additionalProperties: false }, annotations: readOnlyAnnotations },
  { name: 'codex_list_archived_threads', description: 'List archived local Codex tasks/threads with pagination.', inputSchema: { type: 'object', properties: { ...codexPagingProperties, searchTerm: { type: 'string' }, sortKey: { type: 'string', enum: ['created_at', 'updated_at', 'recency_at', 'section_position'] }, useStateDbOnly: { type: 'boolean' } }, additionalProperties: false }, annotations: readOnlyAnnotations },
  { name: 'codex_search_threads', description: 'Full-text search local Codex task/thread history.', inputSchema: { type: 'object', properties: { ...codexPagingProperties, searchTerm: { type: 'string' }, archived: { type: 'boolean' }, sortKey: { type: 'string', enum: ['created_at', 'updated_at', 'recency_at'] } }, required: ['searchTerm'], additionalProperties: false }, annotations: readOnlyAnnotations },
  { name: 'codex_read_thread', description: 'Read a Codex task/thread plus a bounded page of its message/turn history. includeOutputs=true returns all persisted turn items.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, turnLimit: { type: 'integer', minimum: 0, maximum: 50 }, cursor: { type: 'string' }, sortDirection: { type: 'string', enum: ['asc', 'desc'] }, includeOutputs: { type: 'boolean' } }, required: ['threadId'], additionalProperties: false }, annotations: readOnlyAnnotations },
  { name: 'codex_list_thread_turns', description: 'Page through the complete persisted message/turn history of a Codex task.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 }, sortDirection: { type: 'string', enum: ['asc', 'desc'] }, itemsView: { type: 'string', enum: ['notLoaded', 'summary', 'full'] }, includeOutputs: { type: 'boolean' } }, required: ['threadId'], additionalProperties: false }, annotations: readOnlyAnnotations },
  { name: 'codex_list_projects', description: 'List Codex projects with pagination.', inputSchema: { type: 'object', properties: codexPagingProperties, additionalProperties: false }, annotations: readOnlyAnnotations },
  { name: 'codex_read_project', description: 'Read one Codex project.', inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'], additionalProperties: false }, annotations: readOnlyAnnotations },
  { name: 'get_goal', description: 'Read the active goal, status, budget, and usage for a Codex task/thread.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' } }, required: ['threadId'], additionalProperties: false }, annotations: readOnlyAnnotations },
  { name: 'codex_list_background_terminals', description: 'List background terminals owned by a Codex task/thread.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['threadId'], additionalProperties: false }, annotations: readOnlyAnnotations },
  { name: 'codex_create_thread', description: 'Create a Codex task in this workspace and optionally start its first turn. Can spend model usage. Requires Codex mutation opt-in and confirmation=true.', inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, projectId: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] }, approvalPolicy: { type: 'string', enum: ['untrusted', 'on-request', 'never'] }, confirmation: { type: 'boolean' } }, required: ['confirmation'], additionalProperties: false }, annotations: mutationAnnotations },
  { name: 'codex_send_message_to_thread', description: 'Send a prompt as a new turn to an existing local Codex task. Can spend model usage and change files. Requires Codex mutation opt-in and confirmation=true.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, prompt: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, confirmation: { type: 'boolean' } }, required: ['threadId', 'prompt', 'confirmation'], additionalProperties: false }, annotations: mutationAnnotations },
  { name: 'codex_fork_thread', description: 'Fork a Codex task through an optional turn. Requires Codex mutation opt-in and confirmation=true.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, lastTurnId: { type: 'string' }, model: { type: 'string' }, excludeTurns: { type: 'boolean' }, confirmation: { type: 'boolean' } }, required: ['threadId', 'confirmation'], additionalProperties: false }, annotations: mutationAnnotations },
  { name: 'codex_set_thread_archived', description: 'Archive or unarchive a Codex task. Requires Codex mutation opt-in and confirmation=true.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, archived: { type: 'boolean' }, confirmation: { type: 'boolean' } }, required: ['threadId', 'archived', 'confirmation'], additionalProperties: false }, annotations: mutationAnnotations },
  { name: 'codex_set_thread_title', description: 'Rename a Codex task. Requires Codex mutation opt-in and confirmation=true.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, title: { type: 'string' }, confirmation: { type: 'boolean' } }, required: ['threadId', 'title', 'confirmation'], additionalProperties: false }, annotations: mutationAnnotations },
  { name: 'create_goal', description: 'Create an active goal for a Codex task/thread. Set tokenBudget only when the user explicitly requests a budget. Requires Codex mutation opt-in and confirmation=true.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, objective: { type: 'string', minLength: 1 }, tokenBudget: { type: 'integer', minimum: 1 }, confirmation: { type: 'boolean' } }, required: ['threadId', 'objective', 'confirmation'], additionalProperties: false }, annotations: mutationAnnotations },
  { name: 'update_goal', description: 'Mark an existing Codex task goal complete or blocked. Requires Codex mutation opt-in and confirmation=true.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, status: { type: 'string', enum: ['complete', 'blocked'] }, confirmation: { type: 'boolean' } }, required: ['threadId', 'status', 'confirmation'], additionalProperties: false }, annotations: mutationAnnotations },
  { name: 'clear_goal', description: 'Remove the goal from a Codex task/thread. Requires Codex mutation opt-in and confirmation=true.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, confirmation: { type: 'boolean' } }, required: ['threadId', 'confirmation'], additionalProperties: false }, annotations: mutationAnnotations },
  { name: 'codex_interrupt_turn', description: 'Interrupt an active Codex turn. Requires Codex mutation opt-in and confirmation=true.', inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, turnId: { type: 'string' }, confirmation: { type: 'boolean' } }, required: ['threadId', 'turnId', 'confirmation'], additionalProperties: false }, annotations: mutationAnnotations },
]
async function allTools() {
  return [localTools, process.env.CODEX_GATEWAY_ENABLE_CODEX === '1' ? codexTools : []].flat()
}
async function callTool(name, args) {
  if (localTools.some((tool) => tool.name === name) || codexTools.some((tool) => tool.name === name)) return await dispatchLocalTool(name, args)
  throw error(`Unknown tool: ${name}`, 'unknown_tool')
}

// Keep schemas out of the default connector context. Tools and skills are loaded
// only after an explicit task-scoped search.
const { gatewayTools, callGatewayTool } = createGateway({
  localTools, emptySchema, readOnlyAnnotations, mutationAnnotations,
  capabilityReport, allTools, callTool,
  searchSkills: async (input) => await searchSkills(await workspaceRoot(), input),
  readSkill: async (input) => await readSkill(await workspaceRoot(), input),
  structuredResult, error,
})

const rpcResponse = (id, result) => ({ jsonrpc: '2.0', id, result })
const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })
async function handleRpc(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(message?.id ?? null, -32600, 'Invalid JSON-RPC request')
  if (message.id === undefined) return null
  try {
    switch (message.method) {
      case 'initialize': {
        const requested = message.params?.protocolVersion
        return rpcResponse(message.id, {
          protocolVersion: SUPPORTED_VERSIONS.has(requested) ? requested : MCP_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'codex-gateway', version: '0.2.0' },
          instructions: 'Search tools or skills only when the task needs them. Invoke exact tool_search results with tool_call; load skill instructions progressively with skill_read. Local policy and confirmations remain authoritative.',
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
    return rpcResponse(message.id, { content: [{ type: 'text', text: JSON.stringify({ error: cause?.code || 'tool_error', message: cause?.message || String(cause) }) }], isError: true })
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
  codexAppServer?.close()
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

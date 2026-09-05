import { spawn, spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isCompiledRuntime } from './runtime-identity.mjs'

const HELP = `Codex Gateway runtime handover

Usage:
  codex-gateway handover --restart-existing [--profile <name>]
  codex-gateway handover --workspace <path> --tunnel-id <tunnel_...> --runtime-key-file <path> [options]

Options:
  --restart-existing         Reload the current managed profile without re-supplying tunnel credentials
  --workspace <path>          New primary permission root
  --workspace-roots <paths>   Optional comma-separated extra permission roots
  --tunnel-id <tunnel_...>    Existing OpenAI Secure MCP Tunnel ID
  --runtime-key-file <path>   File containing the runtime API key
  --alias <name>              Managed runtime alias (default: codex-gateway-self)
  --profile <name>            tunnel-client profile (default: alias)
  --profile-dir <path>        tunnel-client profile directory override
  --mode <mode>               read-only, developer, or full (default: full)
  --tunnel-client <path>      tunnel-client executable override
  --delay-ms <number>         Delay before replacing the current runtime (default: 1500)
  --no-codex                  Do not expose local Codex task tools
  --help                      Show this help
`

function expandHome(pathname) {
  if (pathname === '~') return homedir()
  if (pathname?.startsWith('~/')) return resolve(homedir(), pathname.slice(2))
  return pathname ? resolve(pathname) : pathname
}

function parseArgs(argv) {
  const options = { codex: true }
  const values = new Set(['workspace', 'workspace-roots', 'tunnel-id', 'runtime-key-file', 'alias', 'profile', 'profile-dir', 'mode', 'tunnel-client', 'delay-ms'])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') options.help = true
    else if (argument === '--restart-existing') options.restartExisting = true
    else if (argument === '--no-codex') options.codex = false
    else if (argument.startsWith('--') && values.has(argument.slice(2))) {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
      options[argument.slice(2)] = value
      index += 1
    } else throw new Error(`Unknown option: ${argument}`)
  }
  return options
}

function validateOptions(options) {
  if (options.restartExisting !== true) {
    if (!options.workspace) throw new Error('--workspace is required')
    if (!/^tunnel_[A-Za-z0-9]+$/.test(options['tunnel-id'] || '')) throw new Error('A valid --tunnel-id is required')
    if (!options['runtime-key-file']) throw new Error('--runtime-key-file is required')
    if (options.mode && !['read-only', 'developer', 'full'].includes(options.mode)) throw new Error('--mode must be read-only, developer, or full')
  }
  const delayMs = Number(options['delay-ms'] || 1500)
  if (!Number.isInteger(delayMs) || delayMs < 250 || delayMs > 30_000) throw new Error('--delay-ms must be between 250 and 30000')
  return delayMs
}

function workerArguments(options) {
  const profile = options.profile || options.alias || 'codex-gateway-self'
  if (options.restartExisting === true) {
    const args = ['restart', '--profile', profile, '--timeout', '30']
    if (options['profile-dir']) args.push('--profile-dir', options['profile-dir'])
    if (options['tunnel-client']) args.push('--tunnel-client', options['tunnel-client'])
    return args
  }

  const args = [
    'onboard',
    '--workspace', options.workspace,
    '--tunnel-id', options['tunnel-id'],
    '--runtime-key-file', options['runtime-key-file'],
    '--alias', options.alias || 'codex-gateway-self',
    '--profile', profile,
    '--mode', options.mode || 'full',
    '--yes',
    '--replace-tunnel-runtime',
  ]
  if (options['workspace-roots']) args.push('--workspace-roots', options['workspace-roots'])
  if (options['tunnel-client']) args.push('--tunnel-client', options['tunnel-client'])
  if (options.codex === false) args.push('--no-codex')
  return args
}

export function cliInvocation(args, compiled = isCompiledRuntime) {
  const cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url))
  return {
    command: process.execPath,
    args: compiled ? args : [cliPath, ...args],
    cwd: compiled ? process.cwd() : resolve(dirname(cliPath), '..'),
  }
}

export async function runHandoverWorker(payload) {
  const options = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  const delayMs = validateOptions(options)
  await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs))

  const invocation = cliInvocation(workerArguments(options))
  const logPath = resolve(homedir(), '.local', 'state', 'codex-gateway', 'handover.log')
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 })
  const startedAt = new Date().toISOString()
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await writeFile(logPath, `${JSON.stringify({
    startedAt,
    completedAt: new Date().toISOString(),
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  }, null, 2)}\n`, { mode: 0o600 })
  process.exitCode = result.status ?? 1
}

export async function handover(argv = []) {
  const options = parseArgs(argv)
  if (options.help) { console.log(HELP); return }
  const delayMs = validateOptions(options)
  const payload = Buffer.from(JSON.stringify(options)).toString('base64url')
  const invocation = cliInvocation(['__handover-worker', payload])
  const child = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  const result = {
    scheduled: true,
    pid: child.pid,
    delayMs,
    mode: options.restartExisting === true ? 'restart-existing' : 'replace-runtime',
    workspace: options.workspace ? expandHome(options.workspace) : null,
    alias: options.alias || 'codex-gateway-self',
    profile: options.profile || options.alias || 'codex-gateway-self',
  }
  console.log(JSON.stringify(result, null, 2))
  return result
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--worker') {
  await runHandoverWorker(process.argv[3])
}

export { HELP, parseArgs, workerArguments }

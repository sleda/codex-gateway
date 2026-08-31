import { spawnSync } from 'node:child_process'
import { access, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const HELP = `Codex Gateway runtime

Usage:
  codex-gateway restart [options]

Options:
  --profile <name>          tunnel-client profile name
  --profile-dir <path>      tunnel-client profile directory
  --tunnel-client <path>    tunnel-client executable
  --timeout <seconds>       readiness timeout (default: 15)
  --help                    Show this help
`

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'workspace'
}

function expandHome(pathname) {
  if (pathname === '~') return homedir()
  if (pathname.startsWith('~/')) return resolve(homedir(), pathname.slice(2))
  return resolve(pathname)
}

function parseRuntimeArgs(argv) {
  const options = {}
  const values = new Set(['profile', 'profile-dir', 'tunnel-client', 'timeout'])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') options.help = true
    else if (argument.startsWith('--') && values.has(argument.slice(2))) {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
      options[argument.slice(2)] = value
      index += 1
    } else throw new Error(`Unknown option: ${argument}`)
  }
  return options
}

async function fileExists(pathname) {
  try { await access(pathname); return true } catch { return false }
}

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (!allowFailure && result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`
    throw new Error(`${basename(command)} failed: ${detail}`)
  }
  return result
}

async function findProfile(profileDirectory, requestedProfile, workspace = process.cwd()) {
  const preferred = requestedProfile || process.env.CODEX_GATEWAY_PROFILE || `codex-gateway-${slug(basename(workspace))}`
  for (const extension of ['yaml', 'yml', 'json']) {
    if (await fileExists(join(profileDirectory, `${preferred}.${extension}`))) return preferred
  }
  const matches = []
  for (const entry of await readdir(profileDirectory).catch(() => [])) {
    if (!/\.(?:ya?ml|json)$/i.test(entry)) continue
    const pathname = join(profileDirectory, entry)
    const content = await readFile(pathname, 'utf8').catch(() => '')
    if (!content.includes('codex-gateway') || !content.includes('server.mjs')) continue
    if (content.includes(`CODEX_GATEWAY_ROOT=${resolve(workspace)}`)) matches.unshift(entry.replace(/\.(?:ya?ml|json)$/i, ''))
    else matches.push(entry.replace(/\.(?:ya?ml|json)$/i, ''))
  }
  if (matches.length === 1 || matches[0]?.includes(slug(basename(workspace)))) return matches[0]
  if (!matches.length) throw new Error(`No Codex Gateway profile found in ${profileDirectory}. Pass --profile explicitly.`)
  throw new Error(`Multiple Codex Gateway profiles found: ${matches.join(', ')}. Pass --profile explicitly.`)
}

async function healthUrlFile(profileDirectory, profile) {
  for (const extension of ['yaml', 'yml', 'json']) {
    const pathname = join(profileDirectory, `${profile}.${extension}`)
    if (!await fileExists(pathname)) continue
    const content = await readFile(pathname, 'utf8')
    try {
      const parsed = JSON.parse(content)
      if (parsed?.health?.url_file) return expandHome(parsed.health.url_file)
    } catch {}
    const match = /^\s*url_file:\s*["']?([^"'\n]+)["']?\s*$/m.exec(content)
    if (match) return expandHome(match[1].trim())
  }
  return join(homedir(), 'Library', 'Application Support', 'tunnel-client', 'health', `${profile}.url`)
}

async function waitUntilReady(urlFile, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1_000
  let lastError = 'health URL is not available'
  while (Date.now() < deadline) {
    try {
      const baseUrl = (await readFile(urlFile, 'utf8')).trim()
      const response = await fetch(`${baseUrl}/readyz`)
      const body = (await response.text()).trim()
      if (response.ok && body === 'ready') return baseUrl
      lastError = `${response.status} ${body}`.trim()
    } catch (cause) { lastError = cause?.message || String(cause) }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  throw new Error(`Runtime did not become ready within ${timeoutSeconds}s: ${lastError}`)
}

export async function restart(argv = []) {
  const options = parseRuntimeArgs(argv)
  if (options.help) { console.log(HELP); return }
  const profileDirectory = expandHome(options['profile-dir'] || process.env.CODEX_GATEWAY_PROFILE_DIR || '~/.config/tunnel-client')
  const profile = await findProfile(profileDirectory, options.profile)
  const tunnelClient = expandHome(options['tunnel-client'] || process.env.TUNNEL_CLIENT_BIN || '~/.local/bin/tunnel-client')
  if (!await fileExists(tunnelClient)) throw new Error(`tunnel-client not found: ${tunnelClient}`)
  const timeoutSeconds = Number(options.timeout || 15)
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 120) throw new Error('--timeout must be between 1 and 120 seconds')
  const session = `tunnel-mcp__${profile}`

  if (run('tmux', ['has-session', '-t', session], { allowFailure: true }).status === 0) {
    run('tmux', ['kill-session', '-t', session])
  }
  run('tmux', ['new-session', '-d', '-s', session, tunnelClient, 'run', '--profile-dir', profileDirectory, '--profile', profile])
  const baseUrl = await waitUntilReady(await healthUrlFile(profileDirectory, profile), timeoutSeconds)
  console.log(`Codex Gateway restarted: ${profile}`)
  console.log(`Status: ready (${baseUrl})`)
  return { profile, profileDirectory, session, baseUrl, ready: true }
}

export { HELP, findProfile, parseRuntimeArgs }

import { spawnSync } from 'node:child_process'
import { access, chmod, mkdir, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'

const DESCRIPTION = 'Connect ChatGPT securely to local Codex tools, project code, task history, and skills.'
const HELP = `Codex Gateway onboarding

Usage:
  codex-gateway onboard [options]

Options:
  --workspace <path>          Workspace exposed by this runtime
  --tunnel-id <tunnel_...>    Existing OpenAI Secure MCP Tunnel ID
  --runtime-key-file <path>   File containing the runtime API key
  --alias <name>              Managed runtime alias
  --profile <name>            tunnel-client profile name
  --mode <mode>               read-only, developer, or full
  --tunnel-client <path>      tunnel-client executable
  --no-codex                  Do not expose local Codex task tools
  --yes                       Accept defaults; requires all secrets to exist
  --dry-run                   Print the resolved setup without changing state
  --help                      Show this help

Examples:
  codex-gateway onboard
  codex-gateway onboard --workspace ~/Projects/acme --tunnel-id tunnel_... \\
    --runtime-key-file ~/.config/openai/codex-gateway-runtime-key --mode developer --yes
`

function parseArgs(argv) {
  const options = { codex: true, yes: false, dryRun: false }
  const values = new Set(['workspace', 'tunnel-id', 'runtime-key-file', 'alias', 'profile', 'mode', 'tunnel-client'])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') options.help = true
    else if (argument === '--yes' || argument === '-y') options.yes = true
    else if (argument === '--dry-run') options.dryRun = true
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

function expandHome(pathname) {
  if (pathname === '~') return homedir()
  if (pathname.startsWith('~/')) return resolve(homedir(), pathname.slice(2))
  return resolve(pathname)
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'workspace'
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_/@%+=:,.-]+$/.test(value)) return value
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function commandExists(command) {
  return spawnSync('which', [command], { encoding: 'utf8' }).stdout.trim() || null
}

async function fileExists(pathname) {
  try { await access(pathname); return true } catch { return false }
}

function createPrompter() {
  let muted = false
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk)
      callback()
    },
  })
  const readline = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) })
  return {
    async text(label, fallback = '') {
      const suffix = fallback ? ` [${fallback}]` : ''
      const answer = (await readline.question(`${label}${suffix}: `)).trim()
      return answer || fallback
    },
    async secret(label) {
      process.stdout.write(`${label}: `)
      muted = true
      const answer = (await readline.question('')).trim()
      muted = false
      process.stdout.write('\n')
      return answer
    },
    async confirm(label, fallback = true) {
      const answer = (await readline.question(`${label} ${fallback ? '[Y/n]' : '[y/N]'}: `)).trim().toLowerCase()
      return answer === '' ? fallback : answer === 'y' || answer === 'yes'
    },
    close() { readline.close() },
  }
}

function gatewayLaunchTokens(workspace, mode, codex) {
  const variables = [
    `CODEX_GATEWAY_ROOT=${workspace}`,
    `CODEX_GATEWAY_ENABLE_CODEX=${codex ? '1' : '0'}`,
    `CODEX_GATEWAY_ALLOW_WRITES=${mode === 'read-only' ? '0' : '1'}`,
    `CODEX_GATEWAY_ALLOW_COMMANDS=${mode === 'read-only' ? '0' : '1'}`,
    `CODEX_GATEWAY_ALLOW_CODEX_MUTATIONS=${mode === 'full' ? '1' : '0'}`,
  ]
  const runningUnderBun = basename(process.execPath).startsWith('bun')
  const executable = runningUnderBun
    ? [process.execPath, 'run', fileURLToPath(new URL('./server.mjs', import.meta.url))]
    : [process.execPath, 'serve']
  return ['/usr/bin/env', ...variables, ...executable, '--transport', 'stdio']
}

function printSummary(config) {
  console.log('\nCodex Gateway setup')
  console.log(`  Workspace:   ${config.workspace}`)
  console.log(`  Mode:        ${config.mode}`)
  console.log(`  Codex tools: ${config.codex ? 'enabled' : 'disabled'}`)
  console.log(`  Tunnel:      ${config.tunnelId}`)
  console.log(`  Runtime:     ${config.alias}`)
  console.log(`  Key file:    ${config.runtimeKeyFile}`)
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`
    throw new Error(`${basename(command)} failed: ${detail}`)
  }
  return result.stdout.trim()
}

export async function onboard(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) { console.log(HELP); return }

  const interactive = !options.yes
  const prompt = interactive ? createPrompter() : null
  try {
    const workspaceInput = options.workspace || await prompt?.text('Workspace path', process.cwd())
    if (!workspaceInput) throw new Error('--workspace is required with --yes')
    const workspace = await realpath(expandHome(workspaceInput))
    const workspaceSlug = slug(basename(workspace))
    const tunnelId = options['tunnel-id'] || await prompt?.text('OpenAI tunnel ID')
    if (!/^tunnel_[A-Za-z0-9]+$/.test(tunnelId || '')) throw new Error('A valid --tunnel-id (tunnel_...) is required')

    const mode = options.mode || await prompt?.text('Permission mode (read-only/developer/full)', 'developer')
    if (!['read-only', 'developer', 'full'].includes(mode)) throw new Error('--mode must be read-only, developer, or full')
    const alias = options.alias || `codex-gateway-${workspaceSlug}`
    const profile = options.profile || alias
    const runtimeKeyFile = expandHome(options['runtime-key-file'] || '~/.config/openai/codex-gateway-runtime-key')
    const tunnelClient = expandHome(options['tunnel-client'] || process.env.TUNNEL_CLIENT_BIN || commandExists('tunnel-client') || '~/.local/bin/tunnel-client')
    if (!await fileExists(tunnelClient)) throw new Error(`tunnel-client not found: ${tunnelClient}`)

    const config = { workspace, tunnelId, mode, alias, profile, runtimeKeyFile, tunnelClient, codex: options.codex }
    printSummary(config)
    if (options.dryRun) {
      console.log('\nDry run: no files or runtimes changed.')
      return config
    }
    if (interactive && !await prompt.confirm('Continue?', true)) return

    if (!await fileExists(runtimeKeyFile)) {
      if (!interactive) throw new Error(`Runtime key file does not exist: ${runtimeKeyFile}`)
      const key = await prompt.secret('Runtime API key (hidden)')
      if (!key.startsWith('sk-')) throw new Error('Runtime API key must start with sk-')
      await mkdir(dirname(runtimeKeyFile), { recursive: true, mode: 0o700 })
      await writeFile(runtimeKeyFile, `${key}\n`, { mode: 0o600, flag: 'wx' })
      await chmod(runtimeKeyFile, 0o600)
    }

    const mcpCommand = gatewayLaunchTokens(workspace, mode, options.codex).map(shellQuote).join(' ')
    console.log('\nConnecting managed runtime…')
    const connectOutput = run(tunnelClient, [
      'runtimes', 'connect', '--json',
      '--alias', alias,
      '--profile', profile,
      '--tunnel-id', tunnelId,
      '--runtime-api-key', `file:${runtimeKeyFile}`,
      '--mcp-command', mcpCommand,
    ])
    if (connectOutput) console.log(connectOutput)

    console.log('\nVerifying runtime…')
    const status = run(tunnelClient, ['runtimes', 'status', alias, '--json'])
    if (status) console.log(status)
    console.log(`\nRuntime is connected. Create a ChatGPT app named “Codex Gateway”, select tunnel ${tunnelId}, and use authentication “None”.`)
    console.log(`Description: ${DESCRIPTION}`)
    return config
  } finally {
    prompt?.close()
  }
}

export { DESCRIPTION, HELP, gatewayLaunchTokens, parseArgs }

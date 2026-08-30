import { spawnSync } from 'node:child_process'
import { access, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

export async function doctor({ strict = false } = {}) {
  const checks = []
  for (const name of ['bun', 'rg', 'git']) {
    const result = spawnSync('which', [name], { encoding: 'utf8' })
    checks.push({ name, required: true, ok: result.status === 0, detail: result.stdout.trim() || 'not found' })
  }

  const configuredCodex = process.env.CODEX_GATEWAY_CODEX_COMMAND || '/Applications/ChatGPT.app/Contents/Resources/codex'
  try {
    await access(configuredCodex)
    checks.push({ name: 'codex app-server', required: process.env.CODEX_GATEWAY_ENABLE_CODEX === '1', ok: true, detail: configuredCodex })
  } catch {
    checks.push({ name: 'codex app-server', required: process.env.CODEX_GATEWAY_ENABLE_CODEX === '1', ok: false, detail: configuredCodex })
  }

  try {
    const root = await realpath(resolve(process.env.CODEX_GATEWAY_ROOT || process.cwd()))
    checks.push({ name: 'workspace root', required: true, ok: (await stat(root)).isDirectory(), detail: root })
  } catch (cause) {
    checks.push({ name: 'workspace root', required: true, ok: false, detail: cause instanceof Error ? cause.message : String(cause) })
  }

  for (const check of checks) console.log(`${check.ok ? '✓' : check.required ? '✗' : '○'} ${check.name}: ${check.detail}`)
  const failures = checks.filter((check) => !check.ok && (check.required || strict && ['bun', 'rg', 'git', 'workspace root'].includes(check.name)))
  return { checks, ok: failures.length === 0 }
}

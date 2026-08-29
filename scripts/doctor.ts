#!/usr/bin/env bun

import { access, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const strict = process.argv.includes('--strict')
const checks: Array<{ name: string; required: boolean; ok: boolean; detail: string }> = []

async function executable(name: string, required: boolean) {
  const result = Bun.spawnSync(['which', name], { stdout: 'pipe', stderr: 'pipe' })
  checks.push({ name, required, ok: result.exitCode === 0, detail: result.stdout.toString().trim() || 'not found' })
}

await executable('bun', true)
await executable('rg', true)
await executable('git', true)
await executable('xcodebuildmcp', process.env.CODEX_LOCAL_GATEWAY_ENABLE_XCODE === '1')

const configuredCodex = process.env.CODEX_LOCAL_GATEWAY_CODEX_COMMAND || '/Applications/ChatGPT.app/Contents/Resources/codex'
try {
  await access(configuredCodex)
  checks.push({ name: 'codex app-server', required: process.env.CODEX_LOCAL_GATEWAY_ENABLE_CODEX === '1', ok: true, detail: configuredCodex })
} catch {
  checks.push({ name: 'codex app-server', required: process.env.CODEX_LOCAL_GATEWAY_ENABLE_CODEX === '1', ok: false, detail: configuredCodex })
}

try {
  const root = await realpath(resolve(process.env.CODEX_LOCAL_GATEWAY_ROOT || process.cwd()))
  checks.push({ name: 'workspace root', required: true, ok: (await stat(root)).isDirectory(), detail: root })
} catch (cause) {
  checks.push({ name: 'workspace root', required: true, ok: false, detail: cause instanceof Error ? cause.message : String(cause) })
}

for (const check of checks) console.log(`${check.ok ? '✓' : check.required ? '✗' : '○'} ${check.name}: ${check.detail}`)
const failures = checks.filter((check) => !check.ok && (check.required || strict && ['bun', 'rg', 'git', 'workspace root'].includes(check.name)))
if (failures.length) process.exit(1)

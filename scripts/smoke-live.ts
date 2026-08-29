#!/usr/bin/env bun

import { resolve } from 'node:path'

const rootArg = process.argv[2]
const root = resolve(rootArg || process.env.CODEX_LOCAL_GATEWAY_ROOT || process.cwd())
const child = Bun.spawn(['bun', 'run', 'src/server.mjs', '--transport', 'stdio'], {
  cwd: resolve(import.meta.dir, '..'),
  env: {
    ...process.env,
    CODEX_LOCAL_GATEWAY_ROOT: root,
    CODEX_LOCAL_GATEWAY_ENABLE_CODEX: '1',
    CODEX_LOCAL_GATEWAY_ENABLE_XCODE: '1',
  },
  stdin: 'pipe', stdout: 'pipe', stderr: 'inherit',
})

const reader = child.stdout.getReader()
const decoder = new TextDecoder()
let buffer = ''
let sequence = 0

async function rpc(name: string, args: Record<string, unknown> = {}) {
  const id = ++sequence
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`)
  await child.stdin.flush()
  while (true) {
    const newline = buffer.indexOf('\n')
    if (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const message = JSON.parse(line)
      if (message.id === id) return message.result
      continue
    }
    const next = await reader.read()
    if (next.done) throw new Error('Gateway closed before returning a response')
    buffer += decoder.decode(next.value, { stream: true })
  }
}

try {
  const info = (await rpc('gateway_info')).structuredContent
  const xcode = (await rpc('tool_inventory', { query: 'xcodebuildmcp__', limit: 1, includeSchema: false })).structuredContent
  console.log(JSON.stringify({
    root,
    publicToolCount: 8,
    internalToolCount: info.exposedToolCount,
    codex: info.codex,
    xcode: info.providers.find((provider: { id: string }) => provider.id === 'xcodebuildmcp') || null,
    xcodeInventoryMatches: xcode.total,
  }, null, 2))
  if (!info.codex.connected || xcode.total < 1) process.exitCode = 1
} finally {
  child.kill()
}

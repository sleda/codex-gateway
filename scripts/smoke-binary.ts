#!/usr/bin/env bun

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { sourceFingerprint } from '../src/runtime-identity.mjs'
import packageJson from '../package.json' with { type: 'json' }

// Copy only the executable: a bundle must not rely on the source checkout.
const directory = await mkdtemp(join(tmpdir(), 'codex-gateway-binary-smoke-'))
const executable = join(directory, 'codex-gateway')
try {
  await copyFile(resolve(import.meta.dir, '..', 'dist', 'codex-gateway'), executable)
  await chmod(executable, 0o755)
  for (const args of [['version'], ['onboard', '--help'], ['handover', '--help']]) {
    const result = spawnSync(executable, args, { cwd: directory, encoding: 'utf8', timeout: 5_000 })
    assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}`)
    if (args[0] === 'version') assert.equal(result.stdout.trim(), packageJson.version)
  }

  const child = Bun.spawn([executable, 'serve', '--transport', 'stdio'], {
    cwd: directory,
    env: {
      ...process.env, CODEX_GATEWAY_ROOT: directory, CODEX_GATEWAY_WORKSPACE_ROOTS: '',
      CODEX_GATEWAY_ENABLE_CODEX: '0', CODEX_GATEWAY_ALLOW_WRITES: '0',
      CODEX_GATEWAY_ALLOW_COMMANDS: '0', CODEX_GATEWAY_ALLOW_CODEX_MUTATIONS: '0',
    },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  })
  const reader = child.stdout.getReader()
  const stderr = new Response(child.stderr).text()
  const timer = setTimeout(() => child.kill(), 8_000)
  const replies = new Map<number, any>()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    const messages = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'binary-smoke', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_call', arguments: { name: 'runtime_info', arguments: {} } } },
    ]
    child.stdin.write(messages.map((message) => JSON.stringify(message)).join('\n') + '\n')
    await child.stdin.flush()
    while (replies.size < 3) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`Compiled server stopped before replying: ${await stderr}`)
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const reply = JSON.parse(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        if (typeof reply.id === 'number') replies.set(reply.id, reply)
      }
    }
    assert.equal(replies.get(1).result.serverInfo.version, packageJson.version)
    assert.equal(replies.get(2).result.tools.length, 10)
    const runtime = replies.get(3).result.structuredContent
    assert.equal(runtime.version, packageJson.version)
    assert.equal(runtime.sourceFingerprint, await sourceFingerprint())
    assert.equal(runtime.cachedConnectorCompatible, true)
    console.log(JSON.stringify({ ok: true, version: runtime.version, sourceFingerprint: runtime.sourceFingerprint, checks: ['isolated executable', 'version', 'onboard help', 'handover help', 'MCP initialize', 'ten-tool ABI', 'runtime identity'] }, null, 2))
  } finally {
    clearTimeout(timer)
    reader.releaseLock()
    child.kill()
    await child.exited
    await stderr
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}

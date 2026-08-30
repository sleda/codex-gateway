#!/usr/bin/env bun

import { resolve } from 'node:path'

const rootArg = process.argv[2]
const root = resolve(rootArg || process.env.CODEX_GATEWAY_ROOT || process.cwd())
const projectRoot = resolve(import.meta.dir, '..')
const child = Bun.spawn(['bun', 'run', 'src/server.mjs', '--transport', 'stdio'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    CODEX_GATEWAY_ROOT: root,
    CODEX_GATEWAY_ENABLE_CODEX: '1',
    CODEX_GATEWAY_SKILL_ROOTS: resolve(projectRoot, 'skills'),
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
  const tools = (await rpc('tool_search', { query: 'read_file', limit: 1 })).structuredContent
  const skills = (await rpc('skill_search', { query: 'gateway', limit: 1 })).structuredContent
  const skill = skills.skills[0]
  const loadedSkill = skill ? await rpc('skill_read', { id: skill.id }) : null
  console.log(JSON.stringify({
    root,
    publicToolCount: 5,
    internalToolCount: info.discoverableToolCount,
    skillCount: info.discoverableSkillCount,
    codex: info.codex,
    toolMatch: tools.tools[0]?.name || null,
    skillMatch: skill?.name || null,
    skillLoaded: loadedSkill?.structuredContent?.skill?.name || null,
  }, null, 2))
  if (!info.codex.connected || tools.tools[0]?.name !== 'read_file' || loadedSkill?.structuredContent?.skill?.name !== 'codex-gateway') process.exitCode = 1
} finally {
  child.kill()
}

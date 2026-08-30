import { afterEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const children: ReturnType<typeof Bun.spawn>[] = []
afterEach(() => children.splice(0).forEach((child) => child.kill()))

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const child = Bun.spawn(['bun', 'run', 'src/server.mjs', '--transport', 'stdio'], {
    cwd: resolve(import.meta.dir, '..'),
    env: {
      ...process.env,
      CODEX_GATEWAY_ROOT: resolve(import.meta.dir, '..'),
      CODEX_GATEWAY_SKILL_ROOTS: resolve(import.meta.dir, '..', 'skills'),
      CODEX_GATEWAY_ENABLE_CODEX: '1',
    },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  })
  children.push(child)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`)
  await child.stdin.flush()
  const reader = child.stdout.getReader()
  let buffer = ''
  const timeout = setTimeout(() => child.kill(), 10_000)
  try {
    while (!buffer.includes('\n')) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += new TextDecoder().decode(value)
    }
  } finally {
    clearTimeout(timeout)
    reader.releaseLock()
  }
  return JSON.parse(buffer.trim())
}

describe('stable public MCP ABI', () => {
  test('advertises the compact gateway surface', async () => {
    const response = await rpc('tools/list')
    expect(response.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'gateway_info', 'tool_search', 'tool_call', 'skill_search', 'skill_read',
    ])
  })

  test('discovers internal workspace tools without exposing them publicly', async () => {
    const response = await rpc('tools/call', { name: 'tool_search', arguments: { query: 'read_file' } })
    expect(response.result.structuredContent.tools[0].name).toBe('read_file')
  })

  test('discovers the native goal lifecycle behind tool search', async () => {
    const response = await rpc('tools/call', { name: 'tool_search', arguments: { query: 'goal' } })
    expect(response.result.structuredContent.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'get_goal', 'create_goal', 'update_goal', 'clear_goal',
    ])
  })

  test('discovers skill metadata before loading its instructions', async () => {
    const searched = await rpc('tools/call', { name: 'skill_search', arguments: { query: 'gateway' } })
    const skill = searched.result.structuredContent.skills[0]
    expect(skill.name).toBe('codex-gateway')

    const read = await rpc('tools/call', { name: 'skill_read', arguments: { id: skill.id } })
    expect(read.result.structuredContent.content).toContain('# Codex Gateway')
  })
})

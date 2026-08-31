import { afterEach, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const children: ReturnType<typeof Bun.spawn>[] = []
const stateDirectory = join(tmpdir(), `codex-gateway-tests-${process.pid}`)
afterEach(async () => {
  children.splice(0).forEach((child) => child.kill())
  await rm(stateDirectory, { recursive: true, force: true })
})

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const child = Bun.spawn(['bun', 'run', 'src/server.mjs', '--transport', 'stdio'], {
    cwd: resolve(import.meta.dir, '..'),
    env: {
      ...process.env,
      CODEX_GATEWAY_ROOT: resolve(import.meta.dir, '..'),
      CODEX_GATEWAY_SKILL_ROOTS: resolve(import.meta.dir, '..', 'skills'),
      CODEX_GATEWAY_STATE_DIR: stateDirectory,
      CODEX_GATEWAY_ENABLE_CODEX: '1',
      CODEX_GATEWAY_ALLOW_COMMANDS: '1',
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
      'gateway_info', 'tool_search', 'tool_call', 'tool_batch', 'skill_search', 'skill_read',
      'create_goal', 'get_goal', 'update_goal', 'clear_goal',
    ])
  })

  test('discovers internal workspace tools without exposing them publicly', async () => {
    const response = await rpc('tools/call', { name: 'tool_search', arguments: { query: 'read_file' } })
    expect(response.result.structuredContent.tools[0].name).toBe('read_file')
  })

  test('runs independent read-only tools as one parallel batch', async () => {
    const response = await rpc('tools/call', {
      name: 'tool_batch',
      arguments: {
        calls: [
          { name: 'workspace_info', arguments: {} },
          { name: 'read_file', arguments: { path: 'package.json', startLine: 1, endLine: 4 } },
        ],
      },
    })
    expect(response.result.structuredContent).toMatchObject({
      parallel: true,
      count: 2,
      results: [{ name: 'workspace_info', ok: true }, { name: 'read_file', ok: true }],
    })
  })

  test('rejects mutation tools from a parallel batch', async () => {
    const response = await rpc('tools/call', {
      name: 'tool_batch',
      arguments: { calls: [{ name: 'write_file', arguments: { path: 'blocked.txt', content: 'no', confirmation: true } }] },
    })
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toContain('batch_mutation_blocked')
  })

  test('runs the installed XcodeBuildMCP CLI through the default command policy', async () => {
    const response = await rpc('tools/call', {
      name: 'tool_call',
      arguments: {
        name: 'exec_command',
        arguments: { command: 'xcodebuildmcp', args: ['--version'], yieldTimeMs: 10_000 },
      },
    })
    expect(response.result.structuredContent).toMatchObject({ running: false, exitCode: 0 })
  })

  test('discovers workspace and Codex goal lifecycles without name collisions', async () => {
    const response = await rpc('tools/call', { name: 'tool_search', arguments: { query: 'goal' } })
    expect(response.result.structuredContent.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'create_goal', 'get_goal', 'update_goal', 'clear_goal',
      'codex_get_goal', 'codex_create_goal', 'codex_update_goal', 'codex_clear_goal',
    ])
  })

  test('persists a Web goal and supports the cached discovery ABI', async () => {
    const created = await rpc('tools/call', { name: 'create_goal', arguments: { objective: 'Verify persistent Web goals' } })
    expect(created.result.structuredContent).toMatchObject({
      goal: { objective: 'Verify persistent Web goals', status: 'active' },
      continuation: { continueInCurrentTurn: true },
    })

    const updated = await rpc('tools/call', { name: 'tool_call', arguments: { name: 'update_goal', arguments: { status: 'active', summary: 'Checkpoint saved', nextSteps: ['Continue in the next Web turn'] } } })
    expect(updated.result.structuredContent).toMatchObject({
      goal: { summary: 'Checkpoint saved', nextSteps: ['Continue in the next Web turn'] },
      continuation: { continueInCurrentTurn: true },
    })

    const read = await rpc('tools/call', { name: 'get_goal', arguments: {} })
    expect(read.result.structuredContent.goal).toMatchObject({ objective: 'Verify persistent Web goals', status: 'active', summary: 'Checkpoint saved' })
    expect(read.result.structuredContent.continuation.continueInCurrentTurn).toBe(true)
  })

  test('discovers skill metadata before loading its instructions', async () => {
    const searched = await rpc('tools/call', { name: 'skill_search', arguments: { query: 'gateway' } })
    const skill = searched.result.structuredContent.skills[0]
    expect(skill.name).toBe('codex-gateway')

    const read = await rpc('tools/call', { name: 'skill_read', arguments: { id: skill.id } })
    expect(read.result.structuredContent.content).toContain('# Codex Gateway')
  })
})

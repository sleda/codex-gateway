import { afterEach, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// These integration checks require the operator's installed Codex, Xcode and simulator.
// Portable CI keeps its filesystem, policy and protocol-fixture tests independent.
const liveTest = process.env.CODEX_GATEWAY_LIVE_TESTS === '1' ? test : test.skip
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
      CODEX_GATEWAY_ALLOW_CODEX_MUTATIONS: '1',
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

  test('reports compact workspace routing data in one gateway_info call', async () => {
    const response = await rpc('tools/call', { name: 'gateway_info', arguments: {} })
    expect(response.result.structuredContent.connectorCompatibility).toMatchObject({
      cachedToolCallSchemaSupported: true,
      cachedSelectorArgument: '__gatewayWorkspace',
      publicActionContract: {
        expected: ['gateway_info', 'tool_search', 'tool_call', 'tool_batch', 'skill_search', 'skill_read', 'create_goal', 'get_goal', 'update_goal', 'clear_goal'],
        readOnly: ['gateway_info', 'tool_search', 'tool_batch', 'skill_search', 'skill_read', 'get_goal'],
        writeCapable: ['tool_call', 'create_goal', 'update_goal', 'clear_goal'],
      },
    })
    expect(response.result.structuredContent.workspaceAccess.discoveredCount).toBeGreaterThanOrEqual(1)
    expect(response.result.structuredContent.workspaceAccess.discoveredWorkspaces).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'codex-gateway', selector: '.' })])
    )
  })

  liveTest('reports live Codex protocol and rendered Apple readiness rather than configuration-only readiness', async () => {
    const response = await rpc('tools/call', { name: 'gateway_info', arguments: {} })
    expect(response.result.structuredContent.codex.protocol).toMatchObject({ dynamic: true })
    expect(response.result.structuredContent.codex.protocol.methodCount).toBeGreaterThan(100)
    expect(response.result.structuredContent.appleDevelopment).toMatchObject({
      ready: true,
      simulatorReady: true,
      probe: 'xcodebuildmcp simulator list',
      probeExitCode: 0,
    })
  })

  test('paginates file discovery without repeating the first page', async () => {
    const first = await rpc('tools/call', { name: 'tool_call', arguments: { name: 'list_files', arguments: { path: 'src', maxEntries: 2, maxDepth: 1 } } })
    const firstPage = first.result.structuredContent
    expect(firstPage.entries).toHaveLength(2)
    expect(firstPage.nextCursor).not.toBeNull()

    const second = await rpc('tools/call', { name: 'tool_call', arguments: { name: 'list_files', arguments: { path: 'src', maxEntries: 2, maxDepth: 1, cursor: firstPage.nextCursor } } })
    const secondPage = second.result.structuredContent
    expect(secondPage.entries).toHaveLength(2)
    expect(secondPage.entries[0].path).not.toBe(firstPage.entries[0].path)
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

  liveTest('runs the installed XcodeBuildMCP CLI through the default command policy', async () => {
    const response = await rpc('tools/call', {
      name: 'tool_call',
      arguments: {
        name: 'exec_command',
        arguments: { command: 'xcodebuildmcp', args: ['--version'], yieldTimeMs: 10_000 },
      },
    })
    expect(response.result.structuredContent).toMatchObject({ running: false, exitCode: 0 })
  })

  liveTest('uses Apple platform tools ahead of stale user-local shims for XcodeBuildMCP', async () => {
    const response = await rpc('tools/call', {
      name: 'tool_call',
      arguments: {
        name: 'exec_readonly',
        arguments: { command: 'xcodebuildmcp', args: ['simulator', 'list'], yieldTimeMs: 10_000, timeoutMs: 30_000 },
      },
    })
    expect(response.result.structuredContent).toMatchObject({ running: false, exitCode: 0, commandPolicy: { readOnly: true } })
    expect(response.result.structuredContent.stdout).toContain('simulators available')
  })

  liveTest('permits XcodeBuildMCP to consume its managed artifact root without granting arbitrary external paths', async () => {
    const managedPath = join(homedir(), 'Library', 'Developer', 'XcodeBuildMCP', 'workspaces', 'gateway-test-missing.app')
    const managed = await rpc('tools/call', {
      name: 'tool_call',
      arguments: {
        name: 'exec_readonly',
        arguments: { command: 'xcodebuildmcp', args: ['simulator', 'get-app-bundle-id', '--app-path', managedPath], yieldTimeMs: 10_000 },
      },
    })
    expect(managed.result.isError).not.toBe(true)
    expect(managed.result.structuredContent.exitCode).not.toBe(0)

    const outside = await rpc('tools/call', {
      name: 'tool_call',
      arguments: {
        name: 'exec_readonly',
        arguments: { command: 'xcodebuildmcp', args: ['simulator', 'get-app-bundle-id', '--app-path', '/etc/not-an-app.app'], yieldTimeMs: 10_000 },
      },
    })
    expect(outside.result.isError).toBe(true)
    expect(outside.result.structuredContent.error.code).toBe('path_outside_workspace')
  })

  test('requires confirmation for general-purpose execution', async () => {
    const response = await rpc('tools/call', {
      name: 'tool_call',
      arguments: { name: 'exec_command', arguments: { command: 'node', args: ['--version'] } },
    })
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toContain('confirmation_required')
    expect(response.result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'confirmation_required', retryable: false },
    })
  })

  test('supports request-scoped workspace selection without changing global state', async () => {
    const response = await rpc('tools/call', {
      name: 'tool_call',
      arguments: { workspace: 'tests', name: 'read_file', arguments: { path: 'gateway.e2e.test.ts', startLine: 1, endLine: 2 } },
    })
    expect(response.result.structuredContent.path).toBe('gateway.e2e.test.ts')
  })

  test('supports cached tool_call schemas with a reserved workspace selector inside arguments', async () => {
    const response = await rpc('tools/call', {
      name: 'tool_call',
      arguments: {
        name: 'read_file',
        arguments: { __gatewayWorkspace: 'tests', path: 'gateway.e2e.test.ts', startLine: 1, endLine: 2 },
      },
    })
    expect(response.result.isError).not.toBe(true)
    expect(response.result.structuredContent.path).toBe('gateway.e2e.test.ts')
  })

  liveTest('discovers and invokes a method generated from the installed Codex schema', async () => {
    const searched = await rpc('tools/call', { name: 'tool_search', arguments: { query: 'codex_rpc__model_list', includeSchema: false } })
    expect(searched.result.structuredContent.tools.some((tool: { name: string }) => tool.name === 'codex_rpc__model_list')).toBe(true)

    const called = await rpc('tools/call', { name: 'tool_call', arguments: { name: 'codex_rpc__model_list', arguments: {} } })
    expect(called.result.isError).not.toBe(true)
    expect(called.result.structuredContent).toBeTruthy()
  })

  liveTest('normalizes Apple tool resolution inside dynamic Codex command execution', async () => {
    const called = await rpc('tools/call', {
      name: 'tool_call',
      arguments: {
        name: 'codex_rpc__command_exec',
        arguments: { command: ['xcrun', '--find', 'xcodebuild'], __gatewayConfirmation: true },
      },
    })
    expect(called.result.isError).not.toBe(true)
    expect(called.result.structuredContent.exitCode).toBe(0)
    expect(called.result.structuredContent.stdout).toContain('/Applications/Xcode')
  })

  liveTest('keeps dynamically discovered Codex filesystem RPCs inside the selected workspace grant', async () => {
    const insidePath = resolve(import.meta.dir, '..', 'package.json')
    const inside = await rpc('tools/call', { name: 'tool_call', arguments: { name: 'codex_rpc__fs_readfile', arguments: { path: insidePath } } })
    expect(inside.result.isError).not.toBe(true)
    expect(inside.result.structuredContent.dataBase64).toBeTruthy()

    const outside = await rpc('tools/call', { name: 'tool_call', arguments: { name: 'codex_rpc__fs_readfile', arguments: { path: '/etc/hosts' } } })
    expect(outside.result.isError).toBe(true)
    expect(outside.result.structuredContent.error.code).toBe('path_outside_workspace')
  })

  liveTest('discovers workspace, compatibility aliases, and dynamic Codex goal RPCs without collisions', async () => {
    const response = await rpc('tools/call', { name: 'tool_search', arguments: { query: 'goal' } })
    const names = response.result.structuredContent.tools.map((tool: { name: string }) => tool.name)
    expect(names).toEqual(expect.arrayContaining([
      'create_goal', 'get_goal', 'update_goal', 'clear_goal',
      'codex_get_goal', 'codex_create_goal', 'codex_update_goal', 'codex_clear_goal',
      'codex_rpc__thread_goal_get', 'codex_rpc__thread_goal_set', 'codex_rpc__thread_goal_clear',
    ]))
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

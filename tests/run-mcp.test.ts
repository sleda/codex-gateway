import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let root: string
let state: string
const project = resolve(import.meta.dir, '..')
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'gateway-run-mcp-')))
  state = join(root, 'state')
  mkdirSync(join(root, 'alpha'))
  mkdirSync(join(root, 'beta'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

async function rpc(name: string, args: Record<string, unknown> = {}, writes = true, method = 'tools/call') {
  // Each request uses a fresh process, and no personal Codex account, network or desktop capability.
  const child = Bun.spawn([process.execPath, 'run', 'src/server.mjs', '--transport', 'stdio'], {
    cwd: project,
    env: {
      ...process.env,
      CODEX_GATEWAY_ROOT: root,
      CODEX_GATEWAY_WORKSPACE_ROOTS: '',
      CODEX_GATEWAY_STATE_DIR: state,
      CODEX_GATEWAY_ENABLE_CODEX: '0',
      CODEX_GATEWAY_ALLOW_WRITES: writes ? '1' : '0',
      CODEX_GATEWAY_ALLOW_COMMANDS: '0',
      CODEX_GATEWAY_ALLOW_CODEX_MUTATIONS: '0',
      CODEX_GATEWAY_SKILL_ROOTS: join(root, 'no-skills'),
    },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  })
  const reader = child.stdout.getReader()
  const timeout = setTimeout(() => child.kill(), 8000)
  let buffer = ''
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: method === 'tools/list' ? {} : { name, arguments: args } }) + '\n')
    await child.stdin.flush()
    const decoder = new TextDecoder()
    while (!buffer.includes('\n')) {
      const { value, done } = await reader.read()
      if (done) throw new Error('Gateway exited before responding: ' + await new Response(child.stderr).text())
      buffer += decoder.decode(value, { stream: true })
    }
    return JSON.parse(buffer.slice(0, buffer.indexOf('\n'))).result
  } finally {
    clearTimeout(timeout)
    reader.releaseLock()
    child.kill()
    await child.exited
  }
}
function request(key: string = randomUUID()) {
  return { goal: 'Generic workspace improvement', tasks: [{ id: 'implement', title: 'Implement' }], criteria: [{ id: 'tests', description: 'Tests pass' }], idempotencyKey: key, confirmation: true }
}
async function call(name: string, args: Record<string, unknown>, workspace = 'alpha', writes = true) {
  return await rpc('tool_call', { name: 'workspace_call', arguments: { workspace, name, arguments: args } }, writes)
}
function expectError(result: any, code: string) {
  expect(result.isError).toBe(true)
  expect(result.structuredContent.error.code).toBe(code)
}

describe('project-independent run MCP contract', () => {
  test('preserves the public ABI and progressively discovers run schemas', async () => {
    const advertised = await rpc('', {}, false, 'tools/list')
    expect(advertised.tools.map((item: any) => item.name)).toEqual([
      'gateway_info', 'tool_search', 'read_call', 'tool_call', 'tool_batch', 'skill_search', 'skill_read',
      'create_goal', 'get_goal', 'update_goal', 'clear_goal',
    ])
    const discovery = await rpc('tool_search', { query: 'run_', includeSchema: true })
    const tools = discovery.structuredContent.tools.filter((item: any) => item.name.startsWith('run_'))
    expect(tools).toHaveLength(10)
    expect(tools.find((item: any) => item.name === 'run_create').annotations.readOnlyHint).toBe(false)
    expect(tools.find((item: any) => item.name === 'run_read').annotations.readOnlyHint).toBe(true)
    expect(tools.find((item: any) => item.name === 'run_transition').inputSchema.required).toContain('expectedRevision')
  })
  test('read-only empty access does not create run storage', async () => {
    const result = await rpc('read_call', { name: 'run_list', workspace: 'alpha', arguments: {} }, false)
    expect(result.structuredContent).toEqual({ runs: [], nextCursor: null })
    expect(existsSync(state)).toBe(false)
  })
  test('write opt-in and confirmation are both mandatory', async () => {
    expectError(await call('run_create', request(), 'alpha', false), 'writes_disabled')
    expect(existsSync(state)).toBe(false)
    const { confirmation, ...withoutConfirmation } = request()
    expectError(await call('run_create', withoutConfirmation), 'confirmation_required')
    expectError(await call('run_create', { ...request(), confirmation: false }), 'confirmation_required')
    expect(existsSync(state)).toBe(false)
  })
  test('read_call and parallel batches cannot launder run mutations', async () => {
    expectError(await rpc('read_call', { name: 'run_create', workspace: 'alpha', arguments: request() }), 'read_call_mutation_blocked')
    const result = await rpc('tool_batch', { workspace: 'alpha', calls: [{ name: 'run_create', arguments: request() }] })
    expect(result.isError).toBe(true)
    expect(existsSync(state)).toBe(false)
  })
  test('cached workspace_call and __gatewayWorkspace routes share one durable state', async () => {
    const created = await call('run_create', request())
    expect(created.isError).toBe(false)
    const run = created.structuredContent.run
    const read = await rpc('tool_call', { name: 'run_read', arguments: { __gatewayWorkspace: 'alpha', runId: run.id } }, false)
    expect(read.structuredContent.run.id).toBe(run.id)
    expect(read.structuredContent.run.workspace).toBe(join(root, 'alpha'))
    const compatibleBatch = await rpc('tool_call', { name: 'workspace_batch', arguments: { workspace: 'alpha', calls: [{ name: 'run_read', arguments: { runId: run.id } }, { name: 'run_events', arguments: { runId: run.id } }] } }, false)
    expect(compatibleBatch.structuredContent.results.every((item: any) => item.ok)).toBe(true)
    expectError(await call('run_read', { runId: run.id }, 'beta', false), 'run_not_found')
  })
  test('workspace selection cannot escape configured grants', async () => {
    const denied = await call('run_create', request(), '..')
    expectError(denied, 'workspace_not_granted')
    expect(existsSync(state)).toBe(false)
  })
  test('actual dispatch validates unknown and nested arguments', async () => {
    expectError(await call('run_create', { ...request(), forgedVerification: true }), 'invalid_run_input')
    expectError(await call('run_create', { ...request(), tasks: [{ id: 'a', title: 'A', hiddenCommand: 'execute' }] }), 'invalid_run_input')
    expectError(await call('run_read', { runId: '../../another-project' }), 'invalid_run_input')
    expect(existsSync(state)).toBe(false)
  })
  test('lifecycle, retries and resume survive separate server processes', async () => {
    const creation = request('stable-key')
    const created = await call('run_create', creation)
    let run = created.structuredContent.run
    const firstRevision = run.revision
    const started = await call('run_transition', { runId: run.id, expectedRevision: run.revision, idempotencyKey: 'start-key', confirmation: true, status: 'running' })
    run = started.structuredContent.run
    expect(run.readyTaskIds).toEqual(['implement'])
    expectError(await call('run_transition', { runId: run.id, expectedRevision: firstRevision, idempotencyKey: 'stale-key', confirmation: true, status: 'cancelled' }), 'run_revision_conflict')
    const replay = await call('run_create', creation)
    expect(replay.structuredContent).toMatchObject({ replayed: true, currentRevision: 2, run: { revision: 1 } })
    expectError(await call('run_transition', { runId: run.id, expectedRevision: run.revision, idempotencyKey: 'premature-key', confirmation: true, status: 'completed' }), 'run_acceptance_unmet')
    const saved = await call('run_checkpoint', { runId: run.id, expectedRevision: run.revision, idempotencyKey: 'checkpoint-key', confirmation: true, summary: 'Resume implementation', nextSteps: ['Run focused tests'] })
    run = saved.structuredContent.run
    const resumed = await call('run_resume_context', { runId: run.id }, 'alpha', false)
    expect(resumed.structuredContent.run.checkpoint).toMatchObject({ summary: 'Resume implementation', revision: 3 })
    expect(resumed.structuredContent.run.execution).toMatchObject({ autonomous: false, filesystemRollback: false })
    const first = await call('run_events', { runId: run.id, limit: 1 }, 'alpha', false)
    const next = await call('run_events', { runId: run.id, afterSequence: first.structuredContent.nextSequence }, 'alpha', false)
    expect(next.structuredContent.events.map((item: any) => item.sequence)).toEqual([2, 3])
  })
  test('legacy goals remain separate from runs', async () => {
    await call('run_create', request())
    const result = await call('get_goal', {}, 'alpha', false)
    expect(result.structuredContent.goal).toBeNull()
    expect((await call('run_list', {}, 'alpha', false)).structuredContent.runs).toHaveLength(1)
  })
})

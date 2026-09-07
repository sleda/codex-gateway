import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { RunStore, validateRunInput } from '../src/run-store.mjs'

let root: string
let workspace: string
let otherWorkspace: string
let state: string
let stores: InstanceType<typeof RunStore>[] = []
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'gateway-run-unit-')))
  workspace = join(root, 'workspace-a')
  otherWorkspace = join(root, 'workspace-b')
  state = join(root, 'state')
  mkdirSync(workspace)
  mkdirSync(otherWorkspace)
})
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  rmSync(root, { recursive: true, force: true })
})
function open(selected = workspace, write = true) {
  const store = new RunStore(selected, state, { write })
  stores.push(store)
  return store
}
function createInput(key: string = randomUUID()) {
  return {
    goal: 'Implement and validate a generic feature',
    tasks: [{ id: 'implement', title: 'Implement the change' }, { id: 'review', title: 'Review the change', dependsOn: ['implement'] }],
    criteria: [{ id: 'tests', description: 'Focused tests pass' }],
    idempotencyKey: key,
    confirmation: true,
  }
}
function create(store = open()) { return store.execute('run_create', createInput()).run }
function mutate(store: InstanceType<typeof RunStore>, name: string, run: any, fields: Record<string, unknown> = {}) {
  return store.execute(name, { runId: run.id, expectedRevision: run.revision, idempotencyKey: randomUUID(), confirmation: true, ...fields }).run
}
function code(fn: () => unknown, expected: string) {
  try { fn(); throw new Error('Expected failure: ' + expected) } catch (error: any) { expect(error.code).toBe(expected) }
}
function completeTasks(store: InstanceType<typeof RunStore>, run: any) {
  for (const id of ['implement', 'review']) {
    run = mutate(store, 'run_task_update', run, { taskId: id, status: 'running' })
    run = mutate(store, 'run_task_update', run, { taskId: id, status: 'completed' })
  }
  return run
}
function dbPath() { return join(state, 'runs', createHash('sha256').update(workspace).digest('hex'), 'runs.sqlite') }

describe('durable run state', () => {
  test('reads do not initialize missing state', () => {
    const store = open(workspace, false)
    expect(store.execute('run_list', {})).toEqual({ runs: [], nextCursor: null })
    code(() => store.execute('run_read', { runId: randomUUID() }), 'run_not_found')
    expect(existsSync(state)).toBe(false)
  })
  test('starts planned, with explicit execution and evidence boundaries', () => {
    const store = open()
    const run = create(store)
    expect(run).toMatchObject({ status: 'planned', revision: 1, workspace, assurance: 'caller_reported', readyTaskIds: [], execution: { autonomous: false, threadReferencesOnly: true, filesystemRollback: false } })
    expect(store.execute('run_events', { runId: run.id }).events).toHaveLength(1)
  })
  test('validates nested bounds, unknown keys and unsafe identifiers at execution time', () => {
    code(() => validateRunInput('run_create', { ...createInput(), extra: true }), 'invalid_run_input')
    code(() => validateRunInput('run_create', { ...createInput(), goal: '  ' }), 'invalid_run_input')
    code(() => validateRunInput('run_create', { ...createInput(), tasks: [{ id: 'a', title: 'a', dependsOn: ['a', 'a'] }] }), 'invalid_run_input')
    code(() => validateRunInput('run_read', { runId: '../../outside' }), 'invalid_run_input')
    code(() => validateRunInput('run_list', { limit: 51 }), 'invalid_run_input')
    code(() => validateRunInput('run_list', { cursor: 1.1 }), 'invalid_run_input')
    code(() => validateRunInput('run_create', { ...createInput(), confirmation: false }), 'invalid_run_input')
  })
  test('rejects cycles, missing dependencies and duplicate identifiers atomically', () => {
    const store = open()
    for (const tasks of [
      [{ id: 'a', title: 'A', dependsOn: ['b'] }, { id: 'b', title: 'B', dependsOn: ['a'] }],
      [{ id: 'a', title: 'A', dependsOn: ['missing'] }],
      [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }],
    ]) code(() => store.execute('run_create', { ...createInput(), tasks }), 'invalid_run_plan')
    code(() => store.execute('run_create', { ...createInput(), criteria: [{ id: 'x', description: 'X' }, { id: 'x', description: 'X' }] }), 'invalid_run_plan')
    expect(store.execute('run_list', {}).runs).toHaveLength(0)
  })
  test('plan replacement only works before running', () => {
    const store = open()
    let run = create(store)
    run = mutate(store, 'run_plan', run, { tasks: [{ id: 'only', title: 'One task' }], criteria: [{ id: 'check', description: 'Check one task' }] })
    expect(run.tasks).toHaveLength(1)
    run = mutate(store, 'run_transition', run, { status: 'running' })
    code(() => mutate(store, 'run_plan', run, { tasks: createInput().tasks, criteria: createInput().criteria }), 'invalid_run_transition')
  })
  test('ready tasks and dependency gates are deterministic', () => {
    const store = open()
    let run = mutate(store, 'run_transition', create(store), { status: 'running' })
    expect(run.readyTaskIds).toEqual(['implement'])
    code(() => mutate(store, 'run_task_update', run, { taskId: 'review', status: 'running' }), 'run_dependencies_unmet')
    code(() => mutate(store, 'run_task_update', run, { taskId: 'implement', status: 'completed' }), 'invalid_run_task_transition')
    run = mutate(store, 'run_task_update', run, { taskId: 'implement', status: 'running', threadId: 'external-thread-1' })
    expect(run.tasks[0].threadId).toBe('external-thread-1')
    run = mutate(store, 'run_task_update', run, { taskId: 'implement', status: 'completed' })
    expect(run.readyTaskIds).toEqual(['review'])
  })
  test('blocking pauses metadata changes without claiming to cancel external workers', () => {
    const store = open()
    let run = mutate(store, 'run_transition', create(store), { status: 'running' })
    run = mutate(store, 'run_transition', run, { status: 'blocked', reason: 'Waiting for operator input' })
    expect(run.readyTaskIds).toEqual([])
    code(() => mutate(store, 'run_task_update', run, { taskId: 'implement', status: 'running' }), 'invalid_run_transition')
    run = mutate(store, 'run_transition', run, { status: 'running' })
    expect(run.readyTaskIds).toEqual(['implement'])
  })
  test('completion gates tasks and explicitly caller-reported criteria', () => {
    const store = open()
    let run = mutate(store, 'run_transition', create(store), { status: 'running' })
    code(() => mutate(store, 'run_transition', run, { status: 'completed' }), 'run_acceptance_unmet')
    run = completeTasks(store, run)
    code(() => mutate(store, 'run_transition', run, { status: 'completed' }), 'run_acceptance_unmet')
    run = mutate(store, 'run_evidence_add', run, { criterionId: 'tests', result: 'passed', summary: 'Operator reports that the focused test passed.' })
    const evidence = store.execute('run_events', { runId: run.id }).events.at(-1).data
    expect(evidence).toMatchObject({ source: 'caller_reported', verification: 'not_independently_verified', result: 'passed' })
    run = mutate(store, 'run_transition', run, { status: 'completed' })
    expect(run.status).toBe('completed')
    for (const [name, fields] of [
      ['run_transition', { status: 'running' }],
      ['run_checkpoint', { summary: 'Cannot modify terminal run', nextSteps: [] }],
      ['run_evidence_add', { criterionId: 'tests', result: 'failed', summary: 'late report' }],
    ] as const) code(() => mutate(store, name, run, fields), 'run_terminal')
  })
  test('later failed evidence supersedes a pass without deleting history', () => {
    const store = open()
    let run = completeTasks(store, mutate(store, 'run_transition', create(store), { status: 'running' }))
    for (const result of ['passed', 'failed']) run = mutate(store, 'run_evidence_add', run, { criterionId: 'tests', result, summary: result })
    expect(run.criteria[0].status).toBe('failed')
    code(() => mutate(store, 'run_transition', run, { status: 'completed' }), 'run_acceptance_unmet')
    expect(store.execute('run_events', { runId: run.id }).events.filter((item: any) => item.kind === 'run_evidence_add')).toHaveLength(2)
  })
  test('terminal cancellation cannot silently reopen', () => {
    const store = open()
    const run = mutate(store, 'run_transition', create(store), { status: 'cancelled' })
    code(() => mutate(store, 'run_transition', run, { status: 'running' }), 'run_terminal')
  })
  test('revision conflicts and idempotent retries do not create extra events', () => {
    const store = open()
    const input = createInput('creation-key')
    const original = store.execute('run_create', input)
    const run = mutate(store, 'run_transition', original.run, { status: 'running' })
    const replay = store.execute('run_create', Object.fromEntries(Object.entries(input).reverse()))
    expect(replay).toMatchObject({ replayed: true, currentRevision: 2, run: { id: run.id, revision: 1 } })
    code(() => store.execute('run_create', { ...input, goal: 'Different request' }), 'run_idempotency_conflict')
    code(() => mutate(store, 'run_transition', original.run, { status: 'cancelled' }), 'run_revision_conflict')
    expect(store.execute('run_events', { runId: run.id }).events).toHaveLength(2)
  })
  test('persists snapshots, metadata checkpoints and event history after reopen', () => {
    const store = open()
    let run = create(store)
    run = mutate(store, 'run_checkpoint', run, { summary: 'Design approved for later continuation', nextSteps: ['Start implementation'] })
    store.close()
    const reopened = open(workspace, false)
    expect(reopened.execute('run_read', { runId: run.id }).run).toEqual(run)
    const context = reopened.execute('run_resume_context', { runId: run.id })
    expect(context.run.checkpoint.summary).toBe('Design approved for later continuation')
    expect(context.run.execution.filesystemRollback).toBe(false)
    expect(context.warnings).toHaveLength(3)
    expect(reopened.execute('run_events', { runId: run.id }).latestSequence).toBe(2)
  })
  test('cursor pages and event byte budgets keep results bounded without losing continuation', () => {
    const store = open()
    const runs = [create(store), create(store), create(store)]
    const first = store.execute('run_list', { limit: 2 })
    const second = store.execute('run_list', { limit: 2, cursor: first.nextCursor })
    expect(first.runs.map((item: any) => item.id)).toEqual(runs.slice(0, 2).map((item) => item.id))
    expect(second.runs.map((item: any) => item.id)).toEqual([runs[2].id])
    let run = runs[0]
    for (let i = 0; i < 10; i++) run = mutate(store, 'run_checkpoint', run, { summary: 's'.repeat(2000), nextSteps: Array(10).fill('n'.repeat(240)) })
    const page = store.execute('run_events', { runId: run.id, limit: 100 })
    expect(JSON.stringify(page).length).toBeLessThan(25_000)
    expect(page.hasMore).toBe(true)
    const next = store.execute('run_events', { runId: run.id, afterSequence: page.nextSequence, limit: 100 })
    expect(next.events[0].sequence).toBe(page.nextSequence + 1)
  })
  test('oversized mutation rolls back the snapshot, event and idempotency record together', () => {
    const store = open()
    let run = store.execute('run_create', { ...createInput(), goal: 'g'.repeat(2000), tasks: Array.from({ length: 32 }, (_, i) => ({ id: `task${i}`, title: 't'.repeat(240) })), criteria: Array.from({ length: 16 }, (_, i) => ({ id: `check${i}`, description: 'd'.repeat(320) })) }).run
    run = mutate(store, 'run_transition', run, { status: 'running' })
    let rejected = false
    for (const item of run.tasks) {
      try { run = mutate(store, 'run_task_update', run, { taskId: item.id, status: 'running', note: 'n'.repeat(500) }) } catch (error: any) { expect(error.code).toBe('run_capacity_exceeded'); rejected = true; break }
    }
    expect(rejected).toBe(true)
    expect(store.execute('run_read', { runId: run.id }).run.revision).toBe(run.revision)
    expect(store.db.query('SELECT count(*) AS n FROM events WHERE run_id=?').get(run.id).n).toBe(run.revision)
    expect(store.db.query('SELECT count(*) AS n FROM requests WHERE run_id=?').get(run.id).n).toBe(run.revision)
  })
  test('isolation is canonical-workspace scoped, including aliases', () => {
    const store = open()
    const run = create(store)
    const other = open(otherWorkspace)
    expect(other.execute('run_list', {}).runs).toHaveLength(0)
    code(() => other.execute('run_read', { runId: run.id }), 'run_not_found')
    const alias = join(root, 'workspace-alias')
    symlinkSync(workspace, alias)
    expect(open(alias, false).execute('run_read', { runId: run.id }).run.id).toBe(run.id)
  })
  test('artifact references cannot traverse or follow a symlink outside the workspace', () => {
    const store = open()
    let run = mutate(store, 'run_transition', create(store), { status: 'running' })
    writeFileSync(join(workspace, 'test-result.txt'), 'test result')
    writeFileSync(join(otherWorkspace, 'outside.txt'), 'not accessible')
    symlinkSync(join(otherWorkspace, 'outside.txt'), join(workspace, 'escape.txt'))
    for (const artifactPath of ['../workspace-b/outside.txt', join(otherWorkspace, 'outside.txt'), 'escape.txt', '.env', 'missing.txt']) code(() => mutate(store, 'run_evidence_add', run, { criterionId: 'tests', result: 'passed', summary: 'claim', artifactPath }), 'invalid_run_artifact')
    run = mutate(store, 'run_evidence_add', run, { criterionId: 'tests', result: 'passed', summary: 'A report file, not independent verification', artifactPath: 'test-result.txt' })
    expect(run.criteria[0].source).toBe('caller_reported')
  })
  test('refuses state inside the workspace and unsafe directory links', () => {
    code(() => new RunStore(workspace, join(workspace, '.state'), { write: true }), 'run_state_inside_workspace')
    expect(existsSync(join(workspace, '.state'))).toBe(false)
    mkdirSync(state, { mode: 0o700 })
    symlinkSync(otherWorkspace, join(state, 'runs'))
    code(() => open(), 'unsafe_run_state')
  })
  test('refuses database hardlinks and overly permissive state directories', () => {
    const store = open()
    create(store)
    store.close()
    linkSync(dbPath(), join(root, 'database-copy.sqlite'))
    code(() => open(workspace, false), 'unsafe_run_state')
    rmSync(join(root, 'database-copy.sqlite'))
    chmodSync(join(state, 'runs'), 0o755)
    code(() => open(workspace, false), 'unsafe_run_state')
  })
  test('corrupt snapshots fail closed rather than being reset', () => {
    const store = open()
    const run = create(store)
    store.db.query('UPDATE runs SET snapshot = ? WHERE id = ?').run('{broken', run.id)
    code(() => store.execute('run_read', { runId: run.id }), 'invalid_run_state')
    expect(store.db.query('SELECT snapshot FROM runs WHERE id = ?').get(run.id).snapshot).toBe('{broken')
  })
  test('corrupt database bytes are never overwritten by recovery', () => {
    const store = open()
    create(store)
    store.close()
    writeFileSync(dbPath(), 'not a sqlite database')
    code(() => open(), 'invalid_run_state')
    expect(readFileSync(dbPath(), 'utf8')).toBe('not a sqlite database')
  })
  test('event update and delete are blocked by database triggers', () => {
    const store = open()
    create(store)
    expect(() => store.db.exec("UPDATE events SET kind='forged'")).toThrow('append-only')
    expect(() => store.db.exec('DELETE FROM events')).toThrow('append-only')
  })
  test('identical terminal mutation retries return the original receipt without new events', () => {
    const store = open()
    const run = create(store)
    const args = { runId: run.id, expectedRevision: run.revision, idempotencyKey: 'cancel-retry', confirmation: true, status: 'cancelled' }
    store.execute('run_transition', args)
    store.close()
    const reopened = open()
    expect(reopened.execute('run_transition', args)).toMatchObject({ replayed: true, currentRevision: 2, run: { status: 'cancelled', revision: 2 } })
    expect(reopened.execute('run_events', { runId: run.id }).events).toHaveLength(2)
  })
  test('corrupt idempotency receipts fail closed instead of returning forged snapshots', () => {
    const store = open()
    const args = createInput('receipt-corruption')
    store.execute('run_create', args)
    store.db.query('UPDATE requests SET response=? WHERE key=?').run(JSON.stringify({ run: {} }), args.idempotencyKey)
    code(() => store.execute('run_create', args), 'invalid_run_state')
    expect(store.db.query('SELECT response FROM requests WHERE key=?').get(args.idempotencyKey).response).toBe(JSON.stringify({ run: {} }))
  })
  test('sensitive artifact aliases and forged evidence origins are rejected', () => {
    const store = open()
    const run = mutate(store, 'run_transition', create(store), { status: 'running' })
    writeFileSync(join(workspace, '.env'), 'fixture-only')
    symlinkSync(join(workspace, '.env'), join(workspace, 'alias.txt'))
    code(() => mutate(store, 'run_evidence_add', run, { criterionId: 'tests', result: 'passed', summary: 'claim', artifactPath: 'alias.txt' }), 'invalid_run_artifact')
    code(() => mutate(store, 'run_evidence_add', run, { criterionId: 'tests', result: 'passed', summary: 'claim', source: 'gateway_verified' }), 'invalid_run_input')
  })
  test('two independent processes cannot both apply the same revision', async () => {
    const store = open()
    const run = create(store)
    const modulePath = resolve(import.meta.dir, '../src/run-store.mjs')
    const script = `import {RunStore} from ${JSON.stringify(modulePath)}; const s=new RunStore(${JSON.stringify(workspace)},${JSON.stringify(state)},{write:true}); try { s.execute('run_checkpoint',{runId:${JSON.stringify(run.id)},expectedRevision:1,idempotencyKey:crypto.randomUUID(),confirmation:true,summary:'Concurrent checkpoint',nextSteps:[]}); console.log('applied'); } catch(e) { console.log(e.code); } finally {s.close()}`
    const results = await Promise.all([0, 1].map(async () => {
      const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
      const result = await new Response(child.stdout).text()
      expect(await child.exited).toBe(0)
      return result.trim()
    }))
    expect(results.sort()).toEqual(['applied', 'run_revision_conflict'])
    expect(store.execute('run_read', { runId: run.id }).run.revision).toBe(2)
  }, 10_000)
})

import { RUN_READ_TOOLS, RUN_SCHEMAS, RunStore, validateRunInput } from './run-store.mjs'

const DESCRIPTIONS = {
  run_create: 'Create a durable, project-independent workspace run with a task DAG and acceptance criteria. Requires write opt-in, confirmation=true and an idempotency key. Does not start a model or command.',
  run_list: 'List durable runs in the selected workspace with bounded cursor pagination. Does not create state when no runs exist.',
  run_read: 'Read one workspace run, its revision, tasks, acceptance states and deterministic ready task IDs. Evidence is caller-reported.',
  run_plan: 'Replace the task DAG and acceptance criteria of a planned run before execution starts. Requires write opt-in, confirmation=true, expectedRevision and an idempotency key.',
  run_transition: 'Change run lifecycle state with revision and acceptance gates. Completing requires all tasks completed and all caller-reported criteria passed. Blocking or cancelling does not stop external workers.',
  run_task_update: 'Update one task through legal dependency-gated state transitions. An optional threadId is metadata only. Requires write opt-in, confirmation=true, expectedRevision and an idempotency key.',
  run_evidence_add: 'Append caller-reported acceptance evidence, optionally referencing an existing non-sensitive workspace file. Never independently attests command execution. Requires write opt-in, confirmation=true, expectedRevision and an idempotency key.',
  run_checkpoint: 'Save a bounded summary and next steps for later continuation. This is a metadata checkpoint, never a filesystem snapshot or rollback. Requires write opt-in, confirmation=true, expectedRevision and an idempotency key.',
  run_resume_context: 'Read bounded run context, ready tasks and latest checkpoint across conversations or process restarts. Does not resume Codex, start workers or execute commands.',
  run_events: 'Read the append-only-by-API run event history after a sequence number, with item and character bounds. Persisted across process restarts.',
}

export function runToolDefinitions() {
  return Object.entries(RUN_SCHEMAS).map(([name, inputSchema]) => ({
    name,
    description: DESCRIPTIONS[name],
    inputSchema,
    annotations: { readOnlyHint: RUN_READ_TOOLS.has(name), destructiveHint: false, openWorldHint: false },
  }))
}
export const isRunTool = (name) => Object.hasOwn(RUN_SCHEMAS, name)

export function dispatchRunTool(name, input, { workspace, stateDirectory, requireWriteConfirmation }) {
  const write = !RUN_READ_TOOLS.has(name)
  if (write) requireWriteConfirmation(input)
  validateRunInput(name, input)
  const store = new RunStore(workspace, stateDirectory, { write })
  try { return store.execute(name, input) } finally { store.close() }
}

export function runCapabilities() {
  return {
    available: true,
    storage: 'workspace-scoped-sqlite',
    schemaVersion: 1,
    writesEnabled: process.env.CODEX_GATEWAY_ALLOW_WRITES === '1',
    confirmationRequired: true,
    optimisticConcurrency: true,
    idempotentMutations: true,
    taskDependencies: true,
    evidenceAssurance: 'caller_reported',
    checkpoints: 'metadata-only',
    autonomousExecution: false,
    filesystemRollback: false,
    discoveryQuery: 'run_',
  }
}

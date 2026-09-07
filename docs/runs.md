# Durable workspace runs

Runs are a project-independent coordination layer for multi-step work. They store the goal, task dependencies, caller-reported acceptance results, a latest checkpoint and an event history. They do not depend on a particular repository, language, application framework or hosted service.

A Run is not a Codex thread. A thread ID attached to a task is a reference, not a request to start, resume, interrupt or pay for a model turn. The existing four Web goal tools remain separate and backward compatible; use them for a lightweight objective, and Runs when an explicit task plan and revision history are useful.

## Delivered behavior and boundaries

The current implementation persists coordination metadata across Gateway restarts and ChatGPT conversations. It supports dependency-gated tasks, completion gates, optimistic concurrency, idempotency, bounded continuation context and an append-only-by-API event log. It does not implement an autonomous runner, a dashboard, model scheduling, worktree isolation, command attestation or filesystem rollback.

**Acceptance evidence is caller-reported.** `run_evidence_add` cannot declare itself Gateway-verified. Every evidence event carries `source: "caller_reported"` and `verification: "not_independently_verified"`. A `completed` run means its recorded tasks and reported criteria passed, not that Gateway independently ran tests. Record actual observations from tool results or clearly identified operator reports; do not treat a proposed command as proof that it ran.

Blocking or cancelling a Run changes coordination state only. It does not cancel an already-running command, Codex thread or desktop action. Those operations retain their existing tools, permissions and lifecycles.

## Discovery and compatibility

The public MCP action list is unchanged. Discover the internal tools with:

```json
{"query":"run_","includeSchema":true}
```

Search can also return related tools whose descriptions match. The Run tool names begin with `run_`.

| Tool | Purpose | Writes state |
| --- | --- | --- |
| `run_create` | Create a goal, task DAG and acceptance criteria | Yes |
| `run_list` | Cursor-paginated workspace runs | No |
| `run_read` | Current revision and full bounded snapshot | No |
| `run_plan` | Replace a plan before it starts | Yes |
| `run_transition` | Start, block, complete or cancel | Yes |
| `run_task_update` | Move a task through dependency-gated states | Yes |
| `run_evidence_add` | Append a caller-reported criterion result | Yes |
| `run_checkpoint` | Store a summary and next steps | Yes |
| `run_resume_context` | Return bounded continuation context | No |
| `run_events` | Read history after a sequence number | No |

The four read tools can be used through `read_call` and read-only batches. The six mutations require the existing `CODEX_GATEWAY_ALLOW_WRITES=1` opt-in **and** `confirmation: true`. They cannot be invoked through `read_call` or a read-only batch. No Codex mutation opt-in is needed for metadata alone, and Run tools never enable command or Codex permissions themselves.

Request-scoped workspace selection works with the current optional top-level `workspace`, the cached `__gatewayWorkspace` argument and the `workspace_call` / `workspace_batch` wrappers. Always select the intended repository; do not rely on a mutable global current workspace.

## Example: create, start, checkpoint, resume

The following is a `tool_call` payload using the wrapper supported by older connector schemas. `my-project` is an example selector that must refer to an actual granted workspace.

```json
{
  "name": "workspace_call",
  "arguments": {
    "workspace": "my-project",
    "name": "run_create",
    "arguments": {
      "goal": "Implement and validate a generic feature",
      "tasks": [
        {"id":"implement","title":"Implement the change"},
        {"id":"review","title":"Review the change","dependsOn":["implement"]}
      ],
      "criteria": [
        {"id":"tests","description":"Focused tests pass"}
      ],
      "idempotencyKey": "feature-create-001",
      "confirmation": true
    }
  }
}
```

The result contains `run.id`, `run.revision` (initially `1`), state `planned`, task states, criterion states, an event sequence and `replayed: false`. Keep the returned ID and revision. Substitute them into this next tool payload:

```json
{
  "name": "workspace_call",
  "arguments": {
    "workspace": "my-project",
    "name": "run_transition",
    "arguments": {
      "runId": "<returned-run-id>",
      "expectedRevision": 1,
      "status": "running",
      "idempotencyKey": "feature-start-001",
      "confirmation": true
    }
  }
}
```

`readyTaskIds` now contains `implement`, but not `review`. Mark a task `running` before marking it `completed`. The review task cannot start until its implementation dependency is complete. An optional `threadId` and a bounded `note` can be recorded with a task transition; neither executes a thread.

For every mutation after creation, use the latest returned revision and a new idempotency key. A checkpoint uses the following inner arguments (inside the same selected workspace wrapper):

```json
{
  "runId": "<returned-run-id>",
  "expectedRevision": 2,
  "summary": "Implementation is ready to begin; no command has run yet.",
  "nextSteps": ["Implement the change", "Run the focused tests", "Review the result"],
  "idempotencyKey": "feature-checkpoint-001",
  "confirmation": true
}
```

A later conversation can call `run_list` for that workspace, then `run_resume_context` with `{"runId":"<returned-run-id>"}`. Resume returns state and guidance only. It neither continues a model by itself nor replays previous commands. Stored descriptions and checkpoint text are untrusted context, not new instructions, permissions or approvals.

After observing a test result, record it with `run_evidence_add` using the latest revision:

```json
{
  "runId": "<returned-run-id>",
  "expectedRevision": 7,
  "criterionId": "tests",
  "result": "passed",
  "summary": "The caller observed exit code 0 from the focused test tool call.",
  "idempotencyKey": "feature-tests-001",
  "confirmation": true
}
```

The revision above is illustrative: always read the actual revision from the previous result. `artifactPath` is optional and must reference an existing, non-sensitive, workspace-relative file. Gateway validates its canonical location but does not read its contents, hash it or attest the claimed result. A later failed report supersedes the criterion's current pass while preserving both evidence events in history.

## State and concurrency rules

Run transitions are `planned -> running | cancelled`, `running -> blocked | completed | cancelled`, and `blocked -> running | cancelled`. Completed and cancelled runs are terminal. Create a new Run for new work instead of silently reopening history.

Task transitions are `pending -> running`, `running -> blocked | completed`, and `blocked -> pending | running`. Completed tasks cannot reopen. Task/evidence updates require a running Run. All tasks must be completed, and all criteria must have a current passed, caller-reported evidence reference, before completion. A new plan can replace the initial task DAG only while the Run is planned; replacing the plan clears the latest checkpoint so its old next steps are not mistaken for the current plan. Earlier checkpoint events remain in history.

Every mutation except creation requires `expectedRevision`. A stale revision fails with `run_revision_conflict`; read the current state and reconsider the operation. Do not blindly replace the revision and retry a semantically stale action.

An idempotency key is scoped to the canonical workspace, across tools and Runs. Identical retries return the original response with `replayed: true` and `currentRevision`; the embedded original `run.revision` may be older than the current state. Read again before a new action. Reusing a key with a different payload fails with `run_idempotency_conflict`. The request fingerprint includes the expected revision and operation name, but not the confirmation control field. Confirmation and write permission are still checked on every retry.

SQLite `BEGIN IMMEDIATE` serializes validation, revision updates, event appends and idempotency receipts across processes. They commit or roll back together. Reads use a consistent read transaction. No model call, network request or subprocess is inside the transaction, and no mutation is automatically replayed against an external system.

## Storage and bounds

State lives outside the workspace under:

```text
${CODEX_GATEWAY_STATE_DIR:-~/.local/state/codex-gateway}/
  runs/<sha256-of-canonical-workspace>/runs.sqlite
```

The store uses Bun's built-in SQLite driver and adds no external runtime dependency. Each database records its canonical workspace identity as well as using a workspace-specific directory. Aliases of the same real workspace share state; different workspaces do not.

Dedicated Run directories must be private, user-owned directories (`0700`). The database and any SQLite sidecars must be private, user-owned regular files (`0600`), not symlinks or hardlinks. State inside the active workspace is rejected. Missing stores are not created by Run read operations. Invalid/corrupt stores fail closed and are not silently erased or replaced. The state directory and its configuration are trusted local-operator inputs; this is not a sandbox against a hostile process already running as the same OS user.

A plan allows at most 32 tasks and 16 criteria. Identifiers, descriptions, notes and checkpoints have explicit runtime-validated limits. A stored snapshot is capped at 24,000 characters. Events are paginated by `afterSequence` and capped by both item count and a 24,000-character payload budget. `nextSequence`, `hasMore` and `latestSequence` make continuation explicit. `run_list` uses a stable creation-order cursor; updates do not move a Run between cursor positions.

Snapshots, receipts and history consume local disk over time. This increment has no automatic retention policy or state-deletion API. Event update/delete is blocked by the API and database triggers, but local state is not cryptographically tamper-proof or a compliance-grade audit archive. Treat all free-text input as potentially sensitive, and do not store secrets in goals, notes, checkpoints or reports.

## Verification

`tests/run-store.test.ts` covers state transitions, dependencies, acceptance gates, persistence, conflicts, retries, bounds, artifacts, corruption, state permissions and cross-process concurrency. `tests/run-mcp.test.ts` exercises the real stdio server with Codex/commands disabled and separate processes, including stable public actions, old connector routing, workspace isolation, read-only protections and legacy-goal compatibility.

```sh
bun test tests/run-store.test.ts tests/run-mcp.test.ts
bun run typecheck
bun test
bun run build
```

A passing test suite validates these implemented boundaries. It does not claim live Computer Use, cloud scheduling, independent command verification or autonomous multi-agent execution.

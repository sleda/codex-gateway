# Architecture

## Decision

Codex Gateway is a Bun ESM MCP server with a small, stable discovery ABI in front of a deliberately dynamic local capability plane. Filesystem, subprocess, Codex app-server, and JSON-RPC I/O dominate runtime cost, so the design optimizes discovery, policy, caching, and concurrency instead of mirroring every provider schema into ChatGPT's default context.

## Public boundary

The connector exposes ten stable public tools:

- `gateway_info` reports live capabilities, protocol identity, permission roots, and readiness without dumping catalogs.
- `tool_search` ranks and returns only relevant internal tools. Small/high-confidence result sets include schemas automatically; broad searches omit schemas unless requested.
- `tool_call` invokes one exact discovered tool and can select a granted workspace for that call.
- `tool_batch` invokes up to sixteen independent read-only tools concurrently within one selected workspace.
- `skill_search` returns deduplicated installed skill metadata by default.
- `skill_read` loads one skill entrypoint or a requested supporting resource.
- `create_goal`, `get_goal`, `update_goal`, and `clear_goal` provide a persistent Web-workspace goal lifecycle without creating a Codex task.

Workspace, command, and Codex app-server methods remain behind discovery. XcodeBuildMCP is used as an installed CLI rather than mirrored as another schema catalog. ChatGPT owns its apps and built-in capabilities.

## Codex protocol compatibility

Codex app-server evolves faster than Gateway releases. The installed Codex binary is therefore the protocol source of truth.

At runtime Gateway asks the configured Codex binary for its version and generates the app-server JSON Schema with:

```text
codex app-server generate-json-schema --out <temporary-directory> --experimental
```

If the installed Codex does not accept `--experimental`, Gateway retries schema generation without it. `ClientRequest.json` is parsed into a live RPC catalog. The parser accepts both `oneOf`/`anyOf`, `definitions`/`$defs`, and both supported local reference forms so ordinary schema-generator changes do not require a Gateway release.

Every discovered request becomes a `codex_rpc__...` internal tool. Only transitively referenced schema definitions are retained for that method, preventing the full protocol graph from being repeated in every tool schema. The catalog is cached against a fingerprint of the installed Codex executable and carries a schema hash. When the binary fingerprint changes, Gateway regenerates the catalog and recreates stale per-workspace app-server children before the next request.

Legacy `codex_*` adapters remain as ergonomic compatibility aliases for common thread/project/goal operations. New Codex methods do not depend on those wrappers and become discoverable automatically.

Unknown future Codex methods default to mutation risk rather than read-only. Gateway adds a collision-resistant `__gatewayConfirmation...` control field to mutation RPC schemas; that field is never forwarded to Codex. Known reads and conservative read/list/get/status patterns can run without mutation confirmation.

## Bidirectional app-server traffic

Codex app-server is bidirectional JSON-RPC. Gateway therefore does not reject server-initiated requests by default. Each per-workspace app-server client:

- buffers notifications with monotonic sequence numbers;
- exposes buffered events and bounded waiting;
- stores server requests that need host input, including approval-style requests;
- exposes pending requests and an explicit confirmed response path;
- preserves Codex RPC error code/data;
- retries `-32001` overload responses with bounded exponential backoff and jitter only for operations classified read-only.

Mutation requests are never automatically replayed.

## Request-scoped workspaces

`CODEX_GATEWAY_ROOT` is the primary permission root. `CODEX_GATEWAY_WORKSPACE_ROOTS` can add explicit permission roots. A single runtime can therefore cover a trusted repository parent such as `~/Documents/Github` while keeping every call inside that grant.

`tool_call` and `tool_batch` accept an optional `workspace` selector. Selection is stored in `AsyncLocalStorage`, so concurrent calls can use different repositories without a mutable global "current workspace". Realpath and symlink resolution are checked before a workspace becomes active.

Each active repository gets its own Codex app-server child, preserving Codex working-directory semantics without restarting Gateway. `workspace_list` discovers Git repositories under the configured grants.

Filesystem tools accept workspace-relative paths. Dynamically discovered Codex RPCs sometimes require absolute filesystem paths; Gateway validates path/cwd/root-like fields, filesystem RPC payloads, and command/process absolute arguments against the selected workspace after realpath resolution before forwarding them.

## Command plane

Commands are shell-free and executable-name allowlisted. Gateway separates two execution surfaces:

- `exec_readonly` accepts only executable/argument combinations classified read-only and can participate in `tool_batch`.
- `exec_command` handles mutation-capable or general-purpose execution and requires `confirmation=true` unless the exact command is classified read-only.

Absolute command arguments are allowed only when their resolved path remains inside the selected workspace grant. Executable paths themselves are not accepted; an allowlisted executable name must resolve through the controlled `PATH`.

For XcodeBuildMCP, Gateway discovers a valid full Xcode developer directory, places Apple system tool directories ahead of user-local shims in the child `PATH`, and injects the selected `DEVELOPER_DIR`. `gateway_info` validates Apple readiness with a real `xcodebuildmcp simulator list` probe rather than merely checking that an Xcode directory exists.

## Progressive disclosure and bounded results

Tool search is ranked exact/prefix/name/token/description instead of catalog-order substring matching. Broad pages omit schemas automatically. Large provider outputs are bounded without duplicating oversized structured payloads into context; continuation metadata such as cursors and offsets is preserved when the main body is omitted.

`list_files` uses deterministic cursor pagination and bounded recursion depth. Skill search canonicalizes duplicate logical skill names across workspace/user/Codex/plugin sources while preserving alternative IDs for explicit inspection.

## Web goals

Web goals are stored outside the repository under the user's local state directory and keyed by the canonical active workspace root. They persist across ChatGPT conversations and tunnel restarts. `update_goal` records a concise checkpoint and next steps so a later Web turn can resume from `get_goal`.

An active goal result carries a continuation envelope as ordinary MCP tool output. The selected ChatGPT Web model remains the orchestrator; Gateway does not use MCP sampling to start autonomous model turns.

## Security and lifecycle

Permission roots, not the process current directory, are the filesystem authority. Request-scoped routing never bypasses write, command, sensitive-path, or Codex mutation policy. Real `.env`, credential, and secret files remain blocked unless separately enabled; documentation templates such as `.env.example`, `.env.sample`, and `.env.template` are not treated as secrets.

For ChatGPT, OpenAI Secure MCP Tunnel starts the stdio Gateway and owns reachability. Onboarding detects already-active local runtimes that use the same tunnel and requires explicit replacement instead of silently creating ambiguous competing targets.

`codex-gateway restart` resolves the managed runtime alias from tunnel-client metadata and reuses its actual managed tmux session name instead of guessing a deterministic session name.

Direct HTTP mode is for local development or a trusted reverse proxy, binds to loopback by default, and requires bearer authentication.

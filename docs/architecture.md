# Architecture

## Decision

Codex Gateway is a Bun ESM MCP server with a small, stable discovery ABI. Filesystem, subprocess, Codex app-server, and JSON-RPC I/O dominate runtime cost, so a Rust rewrite would add adapter complexity without improving the limiting operations.

## Public boundary

The connector exposes ten tools:

- `gateway_info` reports availability without dumping catalogs.
- `tool_search` returns only matching core tool metadata and schemas.
- `tool_call` invokes one exact discovered tool.
- `tool_batch` invokes up to sixteen independent read-only tools concurrently.
- `skill_search` returns installed skill names and descriptions.
- `skill_read` loads one skill entrypoint or a requested supporting resource.
- `create_goal`, `get_goal`, `update_goal`, and `clear_goal` provide a persistent workspace goal lifecycle without creating a Codex task.

Workspace tools and Codex app-server methods remain internal. XcodeBuildMCP and third-party provider catalogs are not proxied. ChatGPT owns its apps and built-in capabilities.

`tool_batch` validates every requested tool against the live catalog before starting any call. Mutations, media results, dependent steps, and recursive batches are rejected; those remain explicit sequential `tool_call` operations. Valid calls start together and return indexed per-call results with isolated errors.

## Web goals

Web goals are stored outside the repository under the user's local state directory and keyed by the canonical workspace root. They persist across ChatGPT conversations and tunnel restarts. `update_goal` records a concise checkpoint and next steps so a later Web turn can resume from `get_goal`.

An active goal result carries a continuation envelope as ordinary MCP tool output. Because tool output is fed back into the same assistant turn, the selected Web model can choose the next step and make another tool call without opening a new conversation turn. This is model-driven continuation inside the originating turn, not a server-initiated MCP message.

The current OpenAI Secure MCP Tunnel bridge accepts request/response traffic initiated by ChatGPT but rejects server-initiated `sampling/createMessage` messages as invalid protocol responses. Codex Gateway therefore does not expose sampling or probe tools. The selected ChatGPT Web model remains the orchestrator: it creates a goal, discovers and invokes workspace tools during its turn, saves checkpoints, and resumes on a later user turn.

Core Codex task operations preserve their native lifecycle semantics behind discovery. Codex-backed goal operations use explicit `codex_*` names so they cannot be confused with Web goals. Desktop-window navigation, panels, sharing, host handoff, and desktop automations remain host-only because the standalone app-server does not own the interactive Codex desktop host.

## Progressive disclosure

Tool and skill catalogs are discovered for the current task rather than embedded in the connector schema. A skill search does not load instructions. `skill_read` first loads `SKILL.md`; supporting references are requested separately when the selected skill routes to them.

Default skill roots are the workspace `.agents/skills`, user `~/.agents/skills`, `$CODEX_HOME/skills`, and installed Codex plugin cache. `CODEX_GATEWAY_SKILL_ROOTS` can replace that set explicitly.

## Security and lifecycle

The configured real workspace root is the filesystem authority. Dynamic routing never bypasses write, command, sensitive-path, or Codex mutation policy. Skill resources must remain inside a discovered skill directory.

For ChatGPT, OpenAI Secure MCP Tunnel starts the stdio gateway and owns its lifetime. `codex-gateway onboard` configures `tunnel-client` managed runtime supervision so health and readiness remain observable without a permanent terminal. Direct HTTP mode is for local development or a trusted reverse proxy, binds to loopback by default, and requires bearer authentication.

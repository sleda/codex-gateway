# Architecture

## Decision

Codex Gateway is a Bun ESM MCP server with a small, stable discovery ABI. Filesystem, subprocess, Codex app-server, and JSON-RPC I/O dominate runtime cost, so a Rust rewrite would add adapter complexity without improving the limiting operations.

## Public boundary

The connector exposes five tools:

- `gateway_info` reports availability without dumping catalogs.
- `tool_search` returns only matching core tool metadata and schemas.
- `tool_call` invokes one exact discovered tool.
- `skill_search` returns installed skill names and descriptions.
- `skill_read` loads one skill entrypoint or a requested supporting resource.

Workspace tools and Codex app-server methods remain internal. XcodeBuildMCP and third-party provider catalogs are not proxied. ChatGPT owns its apps and built-in capabilities.

Core Codex task operations preserve their native lifecycle semantics behind discovery. This includes explicit `create_goal`, `get_goal`, `update_goal`, and `clear_goal` operations backed by the current app-server protocol. Desktop-window navigation, panels, sharing, host handoff, and desktop automations remain host-only because the standalone app-server does not own the interactive Codex desktop host.

## Progressive disclosure

Tool and skill catalogs are discovered for the current task rather than embedded in the connector schema. A skill search does not load instructions. `skill_read` first loads `SKILL.md`; supporting references are requested separately when the selected skill routes to them.

Default skill roots are the workspace `.agents/skills`, user `~/.agents/skills`, `$CODEX_HOME/skills`, and installed Codex plugin cache. `CODEX_GATEWAY_SKILL_ROOTS` can replace that set explicitly.

## Security and lifecycle

The configured real workspace root is the filesystem authority. Dynamic routing never bypasses write, command, sensitive-path, or Codex mutation policy. Skill resources must remain inside a discovered skill directory.

For ChatGPT, OpenAI Secure MCP Tunnel starts the stdio gateway and owns its lifetime. `codex-gateway onboard` configures `tunnel-client` managed runtime supervision so health and readiness remain observable without a permanent terminal. Direct HTTP mode is for local development or a trusted reverse proxy, binds to loopback by default, and requires bearer authentication.

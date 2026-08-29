# Codex Local Gateway

A fast, guarded MCP gateway that lets ChatGPT Web or another MCP client inspect and develop a local workspace, read local Codex task history, and use the complete installed XcodeBuildMCP catalog.

The runtime uses Bun ESM JavaScript, with TypeScript tests and operator tooling. Work is dominated by filesystem and subprocess I/O, so Bun keeps startup and distribution fast while retaining the official MCP TypeScript client ecosystem. Rust would increase adapter complexity without materially improving the limiting operations.

## Architecture

```text
ChatGPT Web / MCP client
          │ 8 stable gateway tools
          ▼
 Codex Local Gateway
   ├─ guarded workspace tools
   ├─ Codex app-server task/history tools
   ├─ XcodeBuildMCP (dynamic catalog)
   └─ future MCP providers
```

The public connector ABI stays small: `gateway_info`, `workspace_info`, `exec_command`, `write_stdin`, `apply_patch`, `view_image`, `tool_inventory`, and `tool_call`. `tool_inventory` searches the exact live internal registry; `tool_call` invokes an exact returned name. Adding a provider therefore does not force ChatGPT to cache hundreds of new connector schemas.

## Quick start

```sh
bun install

CODEX_LOCAL_GATEWAY_ROOT=/absolute/path/to/project \
CODEX_LOCAL_GATEWAY_ENABLE_CODEX=1 \
CODEX_LOCAL_GATEWAY_ENABLE_XCODE=1 \
bun run src/server.mjs --transport stdio
```

Run `bun run doctor` to verify the local runtime. Writes, command execution, and Codex mutations are disabled independently by default; see [.env.example](.env.example).

## ChatGPT Web

ChatGPT Web cannot connect directly to localhost. Create an OpenAI Secure MCP Tunnel and configure its local downstream command as:

```sh
/usr/bin/env \
  CODEX_LOCAL_GATEWAY_ROOT=/absolute/path/to/project \
  CODEX_LOCAL_GATEWAY_ENABLE_CODEX=1 \
  CODEX_LOCAL_GATEWAY_ENABLE_XCODE=1 \
  /absolute/path/to/bun run \
  /absolute/path/to/codex-local-gateway/src/server.mjs --transport stdio
```

The tunnel starts and stops the gateway as its child process. No second background server is required.

## Local policy

- Paths are confined to the configured real workspace root.
- Writes require both a local opt-in and `confirmation: true`.
- Commands are executed without an arbitrary shell and must be allowlisted.
- Codex mutations have an independent opt-in and confirmation.
- HTTP binds to loopback unless explicitly overridden and requires bearer authentication.
- Codex task history is private local data; connect only a trusted tunnel and ChatGPT workspace.

Unlike a broker embedded inside an active outer Codex turn, this standalone gateway cannot honestly claim the outer turn's sandbox or approval lifecycle. It keeps the local operator's policy as the authority rather than simulating turn-scoped approval.

## Development

```sh
bun run typecheck
bun test
bun run smoke:live -- /absolute/path/to/workspace
bun run doctor --strict
bun run build
```

The project is also a Codex plugin through `.codex-plugin/plugin.json` and `.mcp.json`.

## License

MIT

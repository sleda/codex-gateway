# Architecture

## Decision

The runtime is Bun ESM JavaScript with TypeScript tests and operator scripts. Its limiting work is filesystem, subprocess, and JSON-RPC I/O. Bun gives fast startup and optional single-binary compilation while the MCP TypeScript ecosystem keeps provider adapters small.

## Boundaries

- `src/server.mjs` owns transports, guarded workspace operations, and provider clients.
- `src/gateway-tools.mjs` owns the stable public MCP ABI and dynamic inventory/call routing.
- Codex app-server and XcodeBuildMCP remain provider boundaries; their complete catalogs are not copied into the public connector schema.
- The configured real workspace root is the filesystem authority.

## Tool discovery

The public connector exposes eight tools. `tool_inventory` pages and filters the exact live internal registry. `tool_call` accepts only an exact returned name and delegates to the original handler. Adding or removing XcodeBuildMCP workflows does not change the public connector identity.

Workspace writes, commands, and Codex mutations keep their independent local opt-ins. Dynamic routing never bypasses the selected internal tool's own confirmation check.

## Process lifecycle

For ChatGPT Web, OpenAI Secure MCP Tunnel starts the gateway as a stdio child and owns its lifetime. Direct HTTP mode exists for development and trusted reverse proxies, binds to loopback by default, and requires bearer authentication.

# Setup

Install dependencies with `bun install`, then set `CODEX_LOCAL_GATEWAY_ROOT` to the workspace.

For a local MCP client, run `bun run src/server.ts --transport stdio`. For ChatGPT Web, prefer OpenAI Secure MCP Tunnel and configure its downstream as that stdio command. The tunnel owns process lifecycle, so a separate daemon is unnecessary.

Enable Codex task/history with `CODEX_LOCAL_GATEWAY_ENABLE_CODEX=1` and XcodeBuildMCP with `CODEX_LOCAL_GATEWAY_ENABLE_XCODE=1`. Run `bun run doctor` and call `gateway_info` after connecting; live provider counts are the authority.

Direct HTTP mode is available through `bun run start:http`. It binds to loopback by default and requires the bearer token from `CODEX_LOCAL_GATEWAY_TOKEN` or the generated startup token.

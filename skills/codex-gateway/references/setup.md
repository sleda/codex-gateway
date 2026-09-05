# Setup

Install dependencies with `bun install`, then run `bun run onboard`. The onboarder selects one real workspace root, an existing OpenAI tunnel, a local permission mode, and a protected runtime-key file. It creates and verifies a `tunnel-client` managed runtime.

For a local MCP client, run `bun run src/server.mjs --transport stdio`. For ChatGPT, prefer OpenAI Secure MCP Tunnel and the managed runtime produced by onboarding. The tunnel owns process lifecycle, so a separate HTTP daemon is unnecessary.

Create a ChatGPT custom MCP app while the runtime is online. Select the configured tunnel, use authentication `None`, and scan the eleven public actions. Use a separate runtime, tunnel, and ChatGPT app for each workspace. The action list includes direct goal tools for persistent Web work and `tool_batch` for independent parallel reads.

Enable Codex task/history with `CODEX_GATEWAY_ENABLE_CODEX=1`. Run `bun run doctor` and call `gateway_info` after connecting; live capability counts are the authority.

Direct HTTP mode is available through `bun run start:http`. It binds to loopback by default and requires the bearer token from `CODEX_GATEWAY_TOKEN` or the generated startup token.

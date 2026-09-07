# Codex Gateway

![Codex Gateway icon](assets/codex-gateway-icon.png)

Codex Gateway connects ChatGPT Web to granted local development workspaces through an OpenAI Secure MCP Tunnel. One runtime can expose a permission root such as `~/Documents/Github`, select an individual repository per request, and bridge the installed Codex app-server without placing every internal schema in the model's default context.

> Connect ChatGPT securely to local Codex tools, project code, task history, and skills.

## Why it exists

ChatGPT cannot connect directly to `localhost`. Codex Gateway solves the local half of that connection while Secure MCP Tunnel provides the private transport:

```text
ChatGPT Web
    │ custom MCP app (called a plugin/connector in some UI versions)
    ▼
OpenAI Secure MCP Tunnel
    │ outbound connection; no public local port
    ▼
Codex Gateway
    ├─ tool_search → discover relevant local capabilities
    ├─ tool_call   → invoke one discovered capability
    ├─ tool_batch  → run independent read-only capabilities concurrently
    ├─ skill_search
    ├─ skill_read
    └─ create_goal / get_goal / update_goal / clear_goal
         ▼
Granted permission root(s)
    ├─ request-scoped repository selection
    ├─ guarded files / commands / patches / images
    └─ installed Codex app-server
         └─ runtime-generated RPC catalog for the installed Codex version
```

The public MCP surface is pinned to the original ten-tool published snapshot for reconnect compatibility:

- `gateway_info`
- `tool_search`
- `tool_call`
- `tool_batch`
- `skill_search`
- `skill_read`
- `create_goal`
- `get_goal`
- `update_goal`
- `clear_goal`

Workspace, terminal, patch, image, and Codex schemas are returned only when a relevant search requests them. Codex RPC tools are generated from `codex app-server generate-json-schema --experimental` for the installed binary, cached by executable fingerprint, and regenerated automatically when that binary changes. Legacy convenience aliases remain available, but new Codex methods do not require a Gateway release. Skill search returns metadata first; instructions and supporting resources are loaded separately. Third-party provider catalogs such as XcodeBuildMCP are intentionally not mirrored.

Apple development is available without mirroring XcodeBuildMCP's full schema catalog. ChatGPT loads the installed `xcodebuildmcp-cli` skill on demand, discovers the CLI workflow with `--help` / `tools`, and runs `xcodebuildmcp` through the guarded command tool. This includes simulator and physical-device build, test, install, launch, debugging, and UI automation when supported by the installed CLI and host configuration.

When several discovered reads are independent, ChatGPT can send them together through `tool_batch`; the Gateway runs them concurrently and returns indexed results. Mutations and steps that consume earlier results stay sequential.

The four goal tools belong to ChatGPT Web, not to a Codex task. A goal is stored locally per selected workspace and survives new ChatGPT conversations and tunnel restarts. The goal and skill tools accept the same optional `workspace` selector used by repository calls, so a broad permission root does not mix project-local state.

## Durable runs

For structured work, discover `run_` tools: a project-independent Run stores a task DAG, acceptance criteria, caller-reported evidence, checkpoints and event history outside the repository. Revisions and idempotency keys protect concurrent updates and retries. Existing Web goals remain unchanged; the public MCP action list is not expanded.

Run mutations require write opt-in and explicit confirmation. Checkpoints are metadata, not filesystem rollback, and a Run is not an autonomous background worker. See [Durable workspace runs](docs/runs.md) for exact tools, payloads, limits and security boundaries.

## Requirements

- macOS or Linux
- [Bun](https://bun.sh/) 1.3 or newer
- `git` and `rg`
- OpenAI `tunnel-client` available on `PATH` or at `~/.local/bin/tunnel-client`
- An OpenAI Secure MCP Tunnel ID and a runtime API key with **Tunnels Read + Use**
- ChatGPT developer mode for creating a custom MCP app

Full MCP write/modify actions currently depend on ChatGPT plan and workspace policy. See OpenAI's [developer mode and MCP apps guide](https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta).

## Five-minute setup

### 1. Install the gateway

```sh
git clone https://github.com/sleda/codex-gateway.git
cd codex-gateway
bun install
```

Check the local prerequisites:

```sh
bun run src/cli.mjs doctor --strict
```

### 2. Create OpenAI tunnel credentials

Create or select a tunnel in:

- [OpenAI Tunnels](https://platform.openai.com/settings/organization/tunnels)

Create a separate runtime API key in:

- [OpenAI project API keys](https://platform.openai.com/settings/organization/api-keys)

The long-running Gateway needs a runtime key, not an organization admin key. The runtime principal must be allowed to read and use the selected tunnel. The key authenticates the tunnel runtime; Codex task mutations and ChatGPT model usage remain separate operations.

### 3. Run the interactive onboarder

```sh
bun run onboard
```

The onboarder asks for:

1. The primary permission root to expose. For a single project, use the repository itself. To work across many sibling repositories, use their common parent such as `~/Documents/Github`.
2. The existing `tunnel_...` ID.
3. A permission mode.
4. The runtime API key if its protected key file does not exist.

Repository selection is request-scoped. A call can target one granted repository while the next call targets another; no global workspace switch is performed.

`gateway_info` is the fastest routing diagnostic: one call reports the runtime identity, configured grants, and a compact list of discovered repository names/selectors. If ChatGPT has cached an older `tool_call(name, arguments)` schema that does not expose the newer top-level `workspace` field, put `__gatewayWorkspace` inside the tool's `arguments`; Gateway removes that reserved field before forwarding the request. The discoverable `workspace_call` / `workspace_batch` wrappers remain available as an explicit compatibility path.

It stores a newly entered key at `~/.config/openai/codex-gateway-runtime-key` with mode `0600`, creates a managed `tunnel-client` runtime, starts it, and verifies its status. The key value is never placed in the generated MCP command.

For unattended setup:

```sh
bun run src/cli.mjs onboard \
  --workspace /absolute/path/to/project \
  --tunnel-id tunnel_YOUR_ID \
  --runtime-key-file ~/.config/openai/codex-gateway-runtime-key \
  --mode developer \
  --yes
```

Use `--dry-run` to inspect the resolved setup without writing files or starting a runtime.

### 4. Create the ChatGPT app

Open [ChatGPT Apps settings](https://chatgpt.com/#settings/Connectors). Depending on the current UI, the same feature may be labeled **App**, **Connector**, or **Plugin**.

1. Enable **Developer mode** in ChatGPT's advanced Apps settings.
2. Choose **Create app** / **Create custom MCP connector**.
3. Name it `Codex Gateway`.
4. Use this description:

   > Connect ChatGPT securely to local Codex tools, project code, task history, and skills.

5. Upload [`assets/codex-gateway-icon.png`](assets/codex-gateway-icon.png). It is a 256×256 PNG under 10 KB.
6. Select **Tunnel** as the connection type and choose the tunnel used during onboarding.
7. Select **None** for authentication. The Secure MCP Tunnel already authenticates the runtime.
8. Scan/refresh actions and finish creating the app.
9. For a trusted personal development workspace, allow all ten Gateway actions. Local Gateway policy still guards writes, commands, sensitive files, external paths, and Codex mutations independently.

Open a new ChatGPT conversation, select `Codex Gateway` from the tools menu, and try:

> Use Codex Gateway to inspect the connected workspace. Search for only the tools you need and summarize the repository before making changes.

For persistent Web work, try:

> Use Codex Gateway to create a goal for reviewing this repository. Work through the goal with the Web model, save checkpoints as you progress, and mark it complete only when verified.

The app scan should show exactly ten public actions. If it shows an older catalog, refresh the app actions or recreate the draft app while the tunnel runtime is running. An older five-action app can still discover and invoke the goal and batch tools through `tool_search` and `tool_call`, but refreshing provides the intended direct experience.

If ChatGPT reports `Session terminated`, restart the workspace runtime and wait for readiness with one command:

```sh
codex-gateway restart
```

The CLI selects `codex-gateway-<workspace-name>` from the current directory, restarts its tunnel session, and exits only after `/readyz` reports `ready`. Use `--profile <name>` when the profile has a custom name.

## Permission modes

The onboarder applies one of three local policies:

| Mode | Workspace reads | File writes | Allowlisted commands | Codex task mutations |
| --- | --- | --- | --- | --- |
| `read-only` | Yes | No | No | No |
| `developer` (default) | Yes | Yes, with confirmation | Yes | No |
| `full` | Yes | Yes, with confirmation | Yes | Yes, with confirmation |

Even in `full` mode:

- paths remain confined to the selected workspace inside the configured permission grants;
- sensitive files such as `.env` remain blocked unless separately enabled;
- commands are executed without an arbitrary shell and must be allowlisted;
- workspace and Codex mutation tools require `confirmation: true`; goal checkpoints do not modify the repository;
- the outer ChatGPT workspace can apply additional action controls and confirmations.

The default command allowlist includes `xcodebuildmcp` but not raw `xcodebuild`, `xcrun`, or `simctl`. This keeps Apple workflows on the structured, help-discoverable CLI surface. Override the complete allowlist with `CODEX_GATEWAY_COMMAND_ALLOWLIST` only when a workspace requires a different policy.

For `xcodebuildmcp`, Gateway resolves a full Xcode developer directory without changing the machine-wide `xcode-select` setting. It first honors `CODEX_GATEWAY_XCODE_DEVELOPER_DIR` or a valid `DEVELOPER_DIR`, then scans `/Applications`, `~/Applications`, and `~/Downloads`, preferring a valid Xcode Beta bundle when present. Apple system tool directories are placed ahead of user-local shims for that child process, preventing stale `xcrun` wrappers from reintroducing an old `DEVELOPER_DIR`. `gateway_info` runs a real `xcodebuildmcp simulator list` readiness probe rather than reporting configuration-only readiness.

## Work across repositories

Prefer one runtime per permission boundary, not one runtime per repository. For a personal development folder containing sibling Git repositories, onboard the common parent once:

```sh
bun run src/cli.mjs onboard \
  --workspace ~/Documents/Github \
  --tunnel-id tunnel_YOUR_ID \
  --runtime-key-file ~/.config/openai/codex-gateway-runtime-key \
  --alias codex-gateway-self \
  --profile codex-gateway-self \
  --mode full \
  --yes
```

`workspace_list` discovers Git repositories under the grant. `tool_call`, `tool_batch`, goal tools, and skill tools can then select one with `workspace: "repo-name"` or a canonical path inside an explicit grant. Selection uses real paths and `AsyncLocalStorage`, so concurrent calls do not race by mutating global process state.

`CODEX_GATEWAY_ROOT` is the primary grant. `CODEX_GATEWAY_WORKSPACE_ROOTS` can add colon-separated permission roots when projects do not share one parent. Paths, symlinks, dynamic Codex filesystem RPCs, and command working directories remain confined to the selected grant.

Do not run several local runtimes against the same tunnel. The onboarder detects that ambiguity and refuses it unless `--replace-tunnel-runtime` is explicit. `codex-gateway handover` exists for a live self-upgrade: it returns control first, then a detached worker replaces the current runtime after a short delay.

## Runtime operations

The onboarder uses `tunnel-client runtimes connect`, which provides managed local supervision. No `nohup`, background shell, or permanent terminal window is required.

```sh
# List runtimes
tunnel-client runtimes list

# Inspect health and readiness
tunnel-client runtimes status codex-gateway-my-project

# Stop without deleting the remote tunnel
tunnel-client runtimes stop codex-gateway-my-project

# Disconnect the managed runtime
tunnel-client runtimes disconnect codex-gateway-my-project
```

Run onboarding again with the same alias and tunnel to reconnect or update its workspace command.

## Manual tunnel setup

The CLI is recommended, but the underlying setup is intentionally transparent. A tunnel profile starts Gateway over stdio with an explicit workspace:

```sh
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile codex-gateway-my-project \
  --tunnel-id tunnel_YOUR_ID \
  --control-plane-api-key-ref file:/absolute/path/to/runtime-key \
  --health-listen-addr 127.0.0.1:0 \
  --mcp-command "/usr/bin/env CODEX_GATEWAY_ROOT=/absolute/path/to/project CODEX_GATEWAY_ENABLE_CODEX=1 CODEX_GATEWAY_ALLOW_WRITES=1 CODEX_GATEWAY_ALLOW_COMMANDS=1 bun run /absolute/path/to/codex-gateway/src/server.mjs --transport stdio"

tunnel-client doctor --profile codex-gateway-my-project --explain
tunnel-client run --profile codex-gateway-my-project
```

Keep the foreground `run` process open when using the manual path. For long-lived use, prefer the managed runtime created by `codex-gateway onboard`.

## Direct local development

Start stdio MCP without a tunnel:

```sh
CODEX_GATEWAY_ROOT=/absolute/path/to/project \
CODEX_GATEWAY_ENABLE_CODEX=1 \
bun run src/server.mjs --transport stdio
```

Or start authenticated loopback HTTP:

```sh
CODEX_GATEWAY_ROOT=/absolute/path/to/project \
CODEX_GATEWAY_TOKEN="$(openssl rand -hex 32)" \
bun run src/server.mjs --transport http --host 127.0.0.1 --port 8787
```

HTTP binds to loopback by default. Secure MCP Tunnel normally owns the stdio child process, so a second HTTP server is unnecessary for ChatGPT.

## Skills

`skill_search` discovers metadata from these roots by default:

- `<workspace>/.agents/skills`
- `~/.agents/skills`
- `$CODEX_HOME/skills` or `~/.codex/skills`
- installed Codex plugin cache

`skill_read` first loads the selected `SKILL.md`; supporting files are requested separately. Reads are size-bounded and confined to the discovered skill directory. Logical duplicates are collapsed by source precedence unless `includeAlternatives: true` is requested. The catalog is cached in memory and on disk with stale-while-refresh behavior, avoiding repeated plugin-tree scans; `refresh: true` forces a synchronous refresh. Set `CODEX_GATEWAY_SKILL_ROOTS` to a colon-separated list only when you want to replace the defaults explicitly.

## Troubleshooting

### ChatGPT cannot find the app

- Confirm the runtime is running with `tunnel-client runtimes status <alias>`.
- Confirm ChatGPT developer mode is enabled for your account/workspace.
- Create or scan the app only while the tunnel runtime is online.
- Start a new chat and select the app for the message that needs local access.

### The app shows old tools

Gateway exposes a frozen ten-action public contract. New capabilities stay behind `tool_search` / `tool_call`, so a published app does not need a new public action snapshot. If the UI only offers **Reconnect**, use Gateway 0.5.1 or newer and reconnect while the tunnel is healthy. Recreate the app only if its original snapshot predates the ten-action contract.

### `Session terminated` or disconnected streams

Check the managed runtime first:

```sh
tunnel-client runtimes status <alias> --json
```

Then run local diagnostics:

```sh
CODEX_GATEWAY_ROOT=/absolute/path/to/project bun run doctor --strict
```

Do not add a public reverse proxy as a workaround; the supported local/private path is Secure MCP Tunnel.

### ChatGPT can read but cannot edit

First call `gateway_info` and inspect `connectorCompatibility.publicActionContract`. Gateway advertises ten public actions: six read-only actions and four write-capable actions. If ChatGPT exposes only the six read-only actions, the host is filtering write-capable MCP actions rather than the Gateway losing `tool_call`.

Check all three layers before changing the server: the ChatGPT plan/workspace must support full MCP write actions, the app's action controls must enable the write-capable actions, and the local runtime must allow the requested mutation (`developer` or `full` mode as appropriate). Current ChatGPT product availability is plan-dependent, so confirm it in the latest OpenAI developer-mode documentation. Do not mark `tool_call` read-only merely to make it appear: it routes guarded file writes, commands, and Codex mutations and must remain write-capable. Sensitive-file and external-path access stay disabled unless explicitly configured.

## Release status

Version 0.5.1 is the reconnect-compatibility hotfix for the stable ten-action public contract. See [the v0.5.1 release notes](docs/releases/v0.5.1.md) and [the v0.5.0 notes](docs/releases/v0.5.0.md) for the durable Run foundation.

## Development and verification

`bun test` runs the portable suite. The eight installed Codex/Xcode integration checks require an explicitly configured Mac and are enabled with `bun run test:live`. After `bun run build`, run `bun run smoke:binary` to verify the standalone executable outside the source checkout.

```sh
bun run typecheck
bun test
bun run doctor --strict
bun run smoke:live -- /absolute/path/to/workspace
bun run eval:github
CODEX_GATEWAY_EVAL_NATIVE=1 bun run scripts/eval-live.ts ~/Documents/Github
bun run build
```

The compiled binary is written to `dist/codex-gateway`. The repository also contains a Codex-local plugin manifest for users who want Gateway inside Codex itself; that plugin is optional and is not the ChatGPT custom app described above.

See [docs/architecture.md](docs/architecture.md), [SECURITY.md](SECURITY.md), and [CHANGELOG.md](CHANGELOG.md) for implementation and release details.

## License

MIT

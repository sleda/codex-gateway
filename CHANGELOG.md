# Changelog

## 0.5.1 — 2026-09-07

- Restore the original ten-action published MCP snapshot so existing ChatGPT apps can reconnect without a frozen-schema mismatch.
- Keep v0.5 Run, multi-workspace, Codex, Computer Use, and mutation capabilities behind the stable discovery router instead of expanding the public action catalog.
- Pin public action input schemas to the v0.3 published contract; newer workspace selection remains available through the reserved __gatewayWorkspace compatibility argument.
- Add a regression test that freezes the published action schemas and update binary smoke validation to the ten-tool ABI.
- Make runtime instructions require a capability preflight before claiming Gateway is read-only; write availability is determined from gateway_info and discovered mutation tools.
- Keep the hidden read_call compatibility handler for older cached callers without advertising it as a new public action.

## 0.5.0 - 2026-09-07

- Add ten discoverable, project-independent Run tools for durable goals, task dependencies, acceptance criteria, checkpoints, bounded resume context, and paginated event history.
- Store each canonical workspace's Run snapshots, append-only-by-API events, and idempotency receipts in a private SQLite database outside the repository.
- Enforce explicit lifecycle transitions, dependency and completion gates, expected revisions, transactional cross-process updates, and idempotent retries.
- Keep evidence explicitly caller-reported; checkpoints do not roll back files, and Run metadata does not start autonomous workers or execute commands.
- Validate runtime arguments and storage boundaries, including unsafe links, sensitive artifact references, corrupt snapshots, and invalid receipts.
- Preserve the eleven-action public MCP ABI, legacy Web goals, and cached workspace routing; include the read-only router and host-action diagnostics added after v0.4.1.
- Select the narrowest runtime profile granting a workspace and omit stale session IDs after commands finish.
- Include the optional, host-dependent Computer Use bridge through a connected Codex cua_repl runtime; live desktop checks remain opt-in.
- Add 34 Run unit/integration tests and document the protocol and operational limitations.
- Isolate portable MCP contract tests from personal Codex/Xcode sessions while retaining opt-in live coverage.
- Publish as a preview with a macOS ARM64 executable and SHA-256 checksum; no npm publication or downstream application changes.

## 0.4.1 — 2026-09-05

- Replace the fixed Codex app-server method table with a runtime-generated catalog from the installed Codex JSON Schema, including experimental APIs when available and automatic refresh when the bundled Codex executable changes.
- Preserve the compact ten-tool public MCP ABI while exposing 154 locally installed Codex 0.153.1 RPC methods plus compatibility aliases through discovery.
- Support bidirectional Codex app-server traffic with buffered notifications, pending host requests, request responses, and read-only overload retry/backoff.
- Add request-scoped multi-repository access under explicit permission roots, including `workspace_list` and workspace selection for tool, batch, skill, and Web-goal operations.
- Bound dynamically discovered Codex filesystem/process paths to the selected workspace, with canonical real-path and traversal checks.
- Fix Apple validation when a stale user-local `xcrun` shim overrides `DEVELOPER_DIR`; prefer Apple system tool paths for XcodeBuildMCP child processes and report readiness from a real simulator probe.
- Add `exec_readonly`, confirmation for general-purpose execution, cursor-based file discovery, structured remediation errors, ranked tool discovery, and logical skill deduplication.
- Add persistent protocol and skill catalog caches so runtime restarts avoid repeated schema/plugin scans while still refreshing after Codex changes or cache expiry.
- Prevent multiple active local runtimes from silently competing for one tunnel and add `codex-gateway handover` for delayed self-upgrade/rebinding.
- Fix standalone binary startup by embedding source identity at build time; use the embedded CLI for compiled handover workers.
- Align the plugin manifest version, separate opt-in installed-tool tests from portable CI, and add an isolated executable MCP smoke test.
- Publish this version as a preview while the new dynamic compatibility and multi-workspace surfaces continue to mature.
- Add configurable live and optional Apple-native evaluation harnesses without binding the project to a specific downstream repository.

## 0.3.0 — 2026-08-31

- Add persistent workspace-native `create_goal`, `get_goal`, `update_goal`, and `clear_goal` tools for ChatGPT Web without creating Codex tasks.
- Keep active goals moving inside the same assistant turn with continuation checkpoints and concrete next steps.
- Add `tool_batch` for up to sixteen concurrent independent read-only tool calls while keeping mutations sequential.
- Enable the installed XcodeBuildMCP CLI through the guarded command runner for simulator and physical-device workflows.
- Discover a full Xcode developer directory per child process, prefer Xcode Beta when available, and avoid machine-wide `sudo xcode-select` changes.
- Add `codex-gateway restart` with automatic workspace-profile selection and readiness verification.
- Remove the unsupported MCP Sampling probe after Secure MCP Tunnel rejected server-initiated requests.

## 0.2.0 — 2026-08-31

- Rename the project to Codex Gateway.
- Replace the broad public catalog with five discovery-first MCP tools.
- Add progressive Codex skill discovery and bounded skill resource reads.
- Expose guarded workspace and Codex task capabilities behind `tool_search` and `tool_call`.
- Mirror the Codex goal lifecycle as discoverable `create_goal`, `get_goal`, `update_goal`, and `clear_goal` tools.
- Remove XcodeBuildMCP and third-party provider mirroring.
- Add `codex-gateway onboard` for workspace, tunnel runtime, permissions, and health setup.
- Add a complete ChatGPT custom app, Secure MCP Tunnel, and multi-workspace guide.
- Add the 256×256 Codex Gateway app icon.
- Produce an ad-hoc signed macOS CLI binary so the release artifact passes local code-signature validation.

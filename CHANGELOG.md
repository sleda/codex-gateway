# Changelog

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

# Changelog

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

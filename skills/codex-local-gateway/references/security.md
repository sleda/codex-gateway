# Security boundary

The gateway is read-only by default. Enable only the capability needed for the current operator session:

- `CODEX_LOCAL_GATEWAY_ALLOW_WRITES=1`
- `CODEX_LOCAL_GATEWAY_ALLOW_COMMANDS=1`
- `CODEX_LOCAL_GATEWAY_ALLOW_CODEX_MUTATIONS=1`
- `CODEX_LOCAL_GATEWAY_ALLOW_SENSITIVE_WRITES=1`
- `CODEX_LOCAL_GATEWAY_ALLOW_EXTERNAL_PATHS=1`

Keep the workspace root narrow, the command allowlist explicit, and the listener on loopback. Codex history may contain private conversations. Do not connect it to an untrusted tunnel or ChatGPT workspace.

This standalone gateway cannot inherit an outer Codex turn's sandbox or approval authority. Its local policy switches and confirmation arguments are therefore authoritative; do not represent them as turn-scoped Codex approval.

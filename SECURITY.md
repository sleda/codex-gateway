# Security Policy

## Trust model

Codex Gateway gives an MCP client access to one or more explicitly granted local filesystem roots and optionally private Codex task history, app-server capabilities, commands, and installed skills. Use it only with a tunnel and ChatGPT workspace you trust.

The server is read-only by default. Writes, commands, sensitive writes, and Codex mutations are independent operator opt-ins. Dynamic `tool_call` routing and dynamically discovered Codex app-server RPCs do not bypass the selected operation's confirmation or workspace policy.

## Workspace grants

`CODEX_GATEWAY_ROOT` is the primary permission root. `CODEX_GATEWAY_WORKSPACE_ROOTS` can add explicit roots. Request-scoped workspace selection is allowed only inside those grants after realpath and symlink resolution.

Filesystem tools use workspace-relative paths. Some native Codex app-server methods require absolute paths; Gateway validates filesystem RPC payloads, cwd/root/path-like fields, and absolute command/process arguments against the selected workspace before forwarding them. Unknown future Codex methods are conservatively classified as mutations.

Real `.env`, credential, and secret files are blocked from Gateway write tools unless sensitive writes are separately enabled. Documentation templates such as `.env.example`, `.env.sample`, and `.env.template` are not treated as live secret files.

## Commands

Commands execute without an arbitrary shell and must use an allowlisted executable name. `exec_readonly` accepts only combinations classified read-only. General-purpose or mutation-capable `exec_command` calls require `confirmation=true`.

Absolute command arguments are accepted only when they resolve inside the active workspace grant. Executable paths are not accepted. XcodeBuildMCP child processes receive a sanitized system-tool-first `PATH` and an explicitly discovered `DEVELOPER_DIR`, preventing user-local `xcrun` shims from silently changing the selected Xcode toolchain.

## Codex app-server

Gateway generates its Codex request catalog from the installed Codex binary and exposes newly discovered methods behind the stable discovery layer. A binary fingerprint change invalidates the protocol catalog and stale app-server child. Mutation RPCs receive a Gateway-only confirmation field that is removed before forwarding to Codex.

Codex server-initiated requests are buffered for explicit host handling rather than automatically approved. Mutation responses to pending host requests require confirmation. Overload retries are limited to operations classified read-only; mutations are not replayed automatically.

## Transport

HTTP listens on loopback unless explicitly overridden and requires a bearer token. Secure MCP Tunnel stdio mode is preferred because the tunnel owns both reachability and child-process lifetime.

Onboarding detects active local runtimes using the same tunnel and requires explicit replacement. This prevents multiple local MCP targets from competing behind one tunnel identity.

This standalone server is not embedded in an outer Codex turn and therefore does not inherit an outer sandbox or approval lifecycle. Local Gateway policy remains authoritative.

## Reporting

Report vulnerabilities privately through GitHub Security Advisories. Do not include real workspace contents, tokens, tunnel identifiers, or Codex conversation data in a public issue.

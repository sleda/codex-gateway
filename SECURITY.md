# Security Policy

## Trust model

Codex Local Gateway gives an MCP client access to a local workspace and optionally private Codex task history and native development tooling. Use it only with a tunnel and ChatGPT workspace you trust.

The server is read-only by default. Writes, commands, sensitive writes, external paths, and Codex mutations are independent operator opt-ins. Dynamic `tool_call` routing does not bypass the selected tool's confirmation requirement.

HTTP listens on loopback unless explicitly overridden and requires a bearer token. Secure MCP Tunnel stdio mode is preferred because the tunnel owns both reachability and child-process lifetime.

This standalone server is not embedded in an outer Codex turn and therefore does not inherit its sandbox or approval lifecycle. Local policy remains authoritative.

## Reporting

Report vulnerabilities privately through GitHub Security Advisories. Do not include real workspace contents, tokens, tunnel identifiers, or Codex conversation data in a public issue.

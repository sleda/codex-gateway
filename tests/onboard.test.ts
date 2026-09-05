import { describe, expect, test } from 'bun:test'
import { gatewayLaunchTokens, parseArgs } from '../src/onboard.mjs'

describe('onboarding', () => {
  test('builds a developer runtime without enabling Codex mutations', () => {
    const tokens = gatewayLaunchTokens('/tmp/example workspace', 'developer', true, ['/tmp/other'])
    expect(tokens).toContain('CODEX_GATEWAY_ROOT=/tmp/example workspace')
    expect(tokens).toContain('CODEX_GATEWAY_WORKSPACE_ROOTS=/tmp/other')
    expect(tokens).toContain('CODEX_GATEWAY_ALLOW_WRITES=1')
    expect(tokens).toContain('CODEX_GATEWAY_ALLOW_COMMANDS=1')
    expect(tokens).toContain('CODEX_GATEWAY_ALLOW_CODEX_MUTATIONS=0')
    expect(tokens).toContain('CODEX_GATEWAY_ENABLE_CODEX=1')
  })

  test('parses non-interactive setup options', () => {
    const options = parseArgs(['--workspace', '/tmp/repo', '--workspace-roots', '/tmp/other,/tmp/more', '--tunnel-id', 'tunnel_example', '--mode', 'full', '--replace-tunnel-runtime', '--yes'])
    expect(options).toMatchObject({ workspace: '/tmp/repo', 'workspace-roots': '/tmp/other,/tmp/more', 'tunnel-id': 'tunnel_example', mode: 'full', yes: true, codex: true, replaceTunnelRuntime: true })
  })
})

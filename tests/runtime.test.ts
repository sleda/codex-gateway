import { describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findProfile, managedSessionName, parseRuntimeArgs, runtimeAliasFromList } from '../src/runtime.mjs'

describe('runtime CLI', () => {
  test('parses restart options', () => {
    expect(parseRuntimeArgs(['--profile', 'codex-gateway-acme', '--timeout', '20'])).toEqual({
      profile: 'codex-gateway-acme', timeout: '20',
    })
  })

  test('finds the workspace profile', async () => {
    const directory = join(tmpdir(), `codex-gateway-runtime-${process.pid}-${Date.now()}`)
    await mkdir(directory, { recursive: true })
    try {
      await writeFile(join(directory, 'codex-gateway-acme.yaml'), JSON.stringify({
        mcp: { commands: [{ command: '/repo/codex-gateway/src/server.mjs CODEX_GATEWAY_ROOT=/projects/acme' }] },
      }))
      expect(await findProfile(directory, undefined, '/projects/acme')).toBe('codex-gateway-acme')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('finds the narrowest profile that grants a nested workspace', async () => {
    const directory = join(tmpdir(), `codex-gateway-runtime-${process.pid}-${Date.now()}`)
    await mkdir(directory, { recursive: true })
    try {
      await writeFile(join(directory, 'broad.yaml'), JSON.stringify({
        mcp: { commands: [{ command: 'CODEX_GATEWAY_ROOT=/projects /repo/codex-gateway/src/server.mjs' }] },
      }))
      await writeFile(join(directory, 'narrow.yaml'), JSON.stringify({
        mcp: { commands: [{ command: 'CODEX_GATEWAY_ROOT=/projects/team /repo/codex-gateway/src/server.mjs' }] },
      }))
      expect(await findProfile(directory, undefined, '/projects/team/app')).toBe('narrow')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('maps a managed runtime alias to its profile directory and profile name', () => {
    expect(runtimeAliasFromList({ aliases: [
      { alias: 'other', profile_name: 'codex-gateway-acme', profile_dir: '/elsewhere' },
      { alias: 'acme-runtime', profile_name: 'codex-gateway-acme', profile_dir: '/profiles' },
    ] }, '/profiles', 'codex-gateway-acme')).toBe('acme-runtime')
  })

  test('reuses the managed runtime session name instead of guessing it', () => {
    expect(managedSessionName({ process: { session_name: 'tunnel-mcp__codex-gateway-acme__abc123' } }, 'fallback')).toBe('tunnel-mcp__codex-gateway-acme__abc123')
    expect(managedSessionName(null, 'fallback')).toBe('fallback')
  })
})

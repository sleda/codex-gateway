import { describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findProfile, parseRuntimeArgs } from '../src/runtime.mjs'

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
})

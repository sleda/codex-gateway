import { describe, expect, test } from 'bun:test'
import { cliInvocation, parseArgs, workerArguments } from '../src/handover.mjs'

describe('runtime handover', () => {
  test('launches the compiled CLI without a nonexistent embedded source path', () => {
    const args = ['__handover-worker', 'payload']
    expect(cliInvocation(args, true).args).toEqual(args)
    expect(cliInvocation(args, true).cwd).toBe(process.cwd())
    expect(cliInvocation(args, false).args[0]).toMatch(/src\/cli\.mjs$/)
    expect(cliInvocation(args, false).args.slice(1)).toEqual(args)
  })
  test('builds a delayed full-mode replacement without leaking key contents', () => {
    const options = parseArgs([
      '--workspace', '~/Documents/Github',
      '--tunnel-id', 'tunnel_example',
      '--runtime-key-file', '~/.config/openai/runtime-key',
      '--alias', 'codex-gateway-self',
      '--profile', 'codex-gateway-self',
      '--mode', 'full',
      '--delay-ms', '1500',
    ])
    const args = workerArguments(options)
    expect(args).toEqual(expect.arrayContaining([
      'onboard', '--workspace', '~/Documents/Github',
      '--tunnel-id', 'tunnel_example',
      '--runtime-key-file', '~/.config/openai/runtime-key',
      '--replace-tunnel-runtime', '--yes',
    ]))
    expect(args.join(' ')).not.toContain('sk-')
  })

  test('restarts an existing profile without tunnel or runtime-key arguments', () => {
    const options = parseArgs([
      '--restart-existing',
      '--profile', 'codex-gateway-self',
      '--delay-ms', '750',
    ])
    const args = workerArguments(options)
    expect(args).toEqual(['restart', '--profile', 'codex-gateway-self', '--timeout', '30'])
    expect(args.join(' ')).not.toContain('tunnel_')
    expect(args.join(' ')).not.toContain('runtime-key')
  })
})

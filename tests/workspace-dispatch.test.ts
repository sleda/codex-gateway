import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { dispatchWorkspaceTool, workspaceDispatchTools } from '../src/workspace-dispatch.mjs'

const project = resolve(import.meta.dir, '..')
const annotations = {
  readOnlyAnnotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  mutationAnnotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}

async function fixture(run: (root: string, outside: string) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), 'gateway-workspace-abi-'))
  const root = join(base, 'github')
  const outside = join(base, 'not-granted')
  try {
    for (const path of [join(root, 'gateway', '.git'), join(root, 'project-b', '.git'), outside]) await mkdir(path, { recursive: true })
    await writeFile(join(root, 'gateway', 'marker.txt'), 'gateway')
    await writeFile(join(root, 'project-b', 'marker.txt'), 'project-b')
    await writeFile(join(outside, 'marker.txt'), 'private')
    await symlink(outside, join(root, 'escape'))
    await run(await realpath(root), await realpath(outside))
  } finally { await rm(base, { recursive: true, force: true }) }
}

// Run an actual stdio server with only the original public name/arguments ABI.
async function rpcSeries(root: string, requests: Array<Record<string, unknown>>) {
  const child = Bun.spawn(['bun', 'run', 'src/server.mjs', '--transport', 'stdio'], {
    cwd: project,
    env: {
      ...process.env, CODEX_GATEWAY_ROOT: root,
      CODEX_GATEWAY_WORKSPACE_ROOTS: '', CODEX_GATEWAY_ENABLE_CODEX: '0',
      CODEX_GATEWAY_ALLOW_COMMANDS: '0', CODEX_GATEWAY_ALLOW_WRITES: '0',
      CODEX_GATEWAY_ALLOW_CODEX_MUTATIONS: '0',
    },
    stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
  })
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  const replies: any[] = []
  let pending = ''
  const timer = setTimeout(() => child.kill(), 8_000)
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'abi-test', version: '1' } } })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    for (const [index, params] of requests.entries()) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params })}\n`)
    await child.stdin.flush()
    while (replies.length < requests.length) {
      const { value, done } = await reader.read()
      if (done) throw new Error('Server closed before returning every response')
      pending += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0) {
        const response = JSON.parse(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
        if (response.id !== 0) replies.push(response.result)
      }
    }
    return replies
  } finally {
    clearTimeout(timer)
    reader.releaseLock()
    child.kill()
    await child.exited
  }
}

const scoped = (workspace: string, name: string, args: Record<string, unknown> = {}) => ({
  name: 'tool_call', arguments: { name: 'workspace_call', arguments: { workspace, name, arguments: args } },
})

describe('cached-connector workspace dispatch', () => {
  test('preserves target media and argument names without mutating the input', async () => {
    const payload = { workspace: 'project-b', name: 'view_image', arguments: { path: 'a.png', workspace: 'upstream-value' } }
    const image = { content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }], isError: false }
    let received: unknown
    const result = await dispatchWorkspaceTool('workspace_call', payload, async (...args: unknown[]) => { received = args; return image })
    expect(result).toBe(image)
    expect(received).toEqual(['view_image', payload.arguments, { workspace: 'project-b' }])
    expect(payload.arguments.workspace).toBe('upstream-value')
  })

  test('rejects malformed arguments and recursive wrappers', async () => {
    let called = false
    const invoke = async () => { called = true }
    for (const input of [
      { workspace: '', name: 'read_file' },
      { workspace: 'project-b', name: 'workspace_call' },
      { workspace: 'project-b', name: 'tool_batch' },
      { workspace: 'project-b', name: 'read_file', arguments: [] },
      { workspace: 'project-b', name: 'read_file', confirmation: true },
    ]) await expect(dispatchWorkspaceTool('workspace_call', input, invoke)).rejects.toThrow()
    expect(called).toBe(false)
    expect(workspaceDispatchTools(annotations).map((entry: any) => entry.annotations.readOnlyHint)).toEqual([false, true])
  })

  test('discovers fallback tools, reads the selected repository, and leaves the default unchanged', async () => {
    await fixture(async (root) => {
      const replies = await rpcSeries(root, [
        { name: 'tool_search', arguments: { query: 'workspace_call', includeSchema: true } },
        scoped('project-b', 'read_file', { path: 'marker.txt' }),
        scoped('gateway', 'read_file', { path: 'marker.txt' }),
        { name: 'tool_call', arguments: { name: 'runtime_info', arguments: {} } },
      ])
      expect(replies[0].structuredContent.tools[0].inputSchema.required).toEqual(['workspace', 'name'])
      expect(replies[1].structuredContent.content).toBe('project-b')
      expect(replies[2].structuredContent.content).toBe('gateway')
      expect(replies[3].structuredContent.activeWorkspace).toBe(root)
      expect(replies[3].structuredContent.cachedConnectorCompatible).toBe(true)
      expect(replies[3].structuredContent.sourceFingerprint).toMatch(/^[a-f0-9]{24}$/)
    })
  })

  test('supports both the new top-level selector and the original cached ABI', async () => {
    await fixture(async (root) => {
      const replies = await rpcSeries(root, [
        { name: 'tool_call', arguments: { workspace: 'project-b', name: 'read_file', arguments: { path: 'marker.txt' } } },
        scoped('project-b', 'read_file', { path: 'marker.txt' }),
      ])
      expect(replies[0].structuredContent).toEqual(replies[1].structuredContent)
    })
  })

  test('retains grant, symlink and repository boundaries through the wrapper', async () => {
    await fixture(async (root, outside) => {
      const replies = await rpcSeries(root, [
        scoped(outside, 'read_file', { path: 'marker.txt' }),
        scoped('escape', 'read_file', { path: 'marker.txt' }),
        scoped('project-b', 'read_file', { path: '../gateway/marker.txt' }),
      ])
      expect(replies.map((r) => r.isError)).toEqual([true, true, true])
      expect(replies.map((r) => r.structuredContent.error.code)).toEqual(['workspace_not_granted', 'workspace_not_granted', 'path_outside_workspace'])
    })
  })

  test('does not bypass target mutation policy or permit mutations in scoped batches', async () => {
    await fixture(async (root) => {
      const replies = await rpcSeries(root, [
        scoped('project-b', 'write_file', { path: 'marker.txt', content: 'changed', confirmation: true }),
        { name: 'tool_call', arguments: { name: 'workspace_batch', arguments: { workspace: 'project-b', calls: [{ name: 'write_file', arguments: { path: 'marker.txt', content: 'changed', confirmation: true } }] } } },
        { name: 'tool_call', arguments: { name: 'workspace_batch', arguments: { workspace: 'project-b', calls: [{ name: 'read_file', arguments: { path: 'marker.txt' } }] } } },
      ])
      expect(replies[0].structuredContent.error.code).toBe('writes_disabled')
      expect(replies[1].structuredContent.error.code).toBe('batch_mutation_blocked')
      expect(replies[2].structuredContent.results[0].result.content).toBe('project-b')
    })
  })
})

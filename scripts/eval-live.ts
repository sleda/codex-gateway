#!/usr/bin/env bun

import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const permissionRoot = resolve(process.argv[2] || process.env.CODEX_GATEWAY_ROOT || process.cwd())
const projectRoot = resolve(import.meta.dir, '..')
const selectedWorkspace = process.env.CODEX_GATEWAY_EVAL_WORKSPACE || 'codex-gateway'
const xcodeWorkspace = process.env.CODEX_GATEWAY_EVAL_XCODE_WORKSPACE || null
const xcodeScheme = process.env.CODEX_GATEWAY_EVAL_XCODE_SCHEME || null
const simulatorName = process.env.CODEX_GATEWAY_EVAL_SIMULATOR || 'iPhone 17 Pro'
const onlyTesting = process.env.CODEX_GATEWAY_EVAL_ONLY_TESTING || null

const child = Bun.spawn(['bun', 'run', 'src/server.mjs', '--transport', 'stdio'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    CODEX_GATEWAY_ROOT: permissionRoot,
    CODEX_GATEWAY_ENABLE_CODEX: '1',
    CODEX_GATEWAY_ALLOW_COMMANDS: '1',
    CODEX_GATEWAY_ALLOW_WRITES: '1',
    CODEX_GATEWAY_ALLOW_CODEX_MUTATIONS: '1',
    CODEX_GATEWAY_SKILL_ROOTS: resolve(projectRoot, 'skills'),
  },
  stdin: 'pipe', stdout: 'pipe', stderr: 'inherit',
})

const reader = child.stdout.getReader()
const decoder = new TextDecoder()
let buffer = ''
let sequence = 0
const timings: Record<string, number> = {}

async function rpc(name: string, args: Record<string, unknown> = {}) {
  const id = ++sequence
  const started = performance.now()
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`)
  await child.stdin.flush()
  while (true) {
    const newline = buffer.indexOf('\n')
    if (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const message = JSON.parse(line)
      if (message.id !== id) continue
      timings[`${name}#${id}`] = Math.round((performance.now() - started) * 10) / 10
      return message.result
    }
    const next = await reader.read()
    if (next.done) throw new Error('Gateway closed before returning a response')
    buffer += decoder.decode(next.value, { stream: true })
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function runGatewayCommand(workspace: string, toolName: string, args: Record<string, unknown>) {
  let result = await rpc('tool_call', { workspace, name: toolName, arguments: args })
  if (result.isError === true) return result
  const chunks = [result.structuredContent?.stdout || '']
  const errors = [result.structuredContent?.stderr || '']
  while (result.structuredContent?.running === true) {
    result = await rpc('tool_call', {
      workspace,
      name: 'write_stdin',
      arguments: { sessionId: result.structuredContent.sessionId, yieldTimeMs: 30_000, maxOutputChars: 200_000 },
    })
    chunks.push(result.structuredContent?.stdout || '')
    errors.push(result.structuredContent?.stderr || '')
  }
  if (result.structuredContent) {
    result.structuredContent.stdout = chunks.join('')
    result.structuredContent.stderr = errors.join('')
  }
  return result
}

try {
  const info = (await rpc('gateway_info')).structuredContent
  assert(info?.codex?.available === true, 'Codex app-server protocol is not available')
  assert(['lazy', 'connected'].includes(info.codex.connectionState), 'Codex app-server connection state is invalid')
  assert(info?.codex?.protocol?.dynamic === true && info.codex.protocol.methodCount > 100, 'Dynamic Codex protocol discovery is not active')

  const workspaceList = (await rpc('tool_call', { name: 'workspace_list', arguments: {} })).structuredContent
  const workspaceNames = workspaceList.workspaces.map((entry: { name: string }) => entry.name)
  assert(workspaceNames.includes('codex-gateway'), 'codex-gateway workspace was not discovered')
  assert(workspaceNames.includes(selectedWorkspace), `Selected workspace was not discovered: ${selectedWorkspace}`)

  const gatewayPackage = (await rpc('tool_call', { workspace: 'codex-gateway', name: 'read_file', arguments: { path: 'package.json', startLine: 1, endLine: 8 } })).structuredContent
  assert(gatewayPackage.path === 'package.json', 'Could not read codex-gateway through request-scoped workspace')

  const selectedInfo = (await rpc('tool_call', { workspace: selectedWorkspace, name: 'workspace_info', arguments: {} })).structuredContent
  assert(typeof selectedInfo.root === 'string', 'Request-scoped workspace did not resolve')

  const modelList = await rpc('tool_call', { name: 'codex_rpc__model_list', arguments: {} })
  assert(modelList.isError !== true && modelList.structuredContent, 'Dynamic Codex model/list RPC failed')

  const dynamicFsInside = await rpc('tool_call', {
    workspace: 'codex-gateway',
    name: 'codex_rpc__fs_readfile',
    arguments: { path: resolve(projectRoot, 'package.json') },
  })
  assert(dynamicFsInside.isError !== true && dynamicFsInside.structuredContent?.dataBase64, 'Dynamic fs/readFile failed inside selected workspace')

  const dynamicFsOutside = await rpc('tool_call', {
    workspace: 'codex-gateway',
    name: 'codex_rpc__fs_readfile',
    arguments: { path: '/etc/hosts' },
  })
  assert(dynamicFsOutside.isError === true && dynamicFsOutside.structuredContent?.error?.code === 'path_outside_workspace', 'Dynamic fs/readFile escaped its workspace grant')

  let appleAcceptance: Record<string, unknown> | null = null
  if (xcodeWorkspace || xcodeScheme || process.env.CODEX_GATEWAY_EVAL_NATIVE === '1') {
    assert(xcodeWorkspace && xcodeScheme, 'Set CODEX_GATEWAY_EVAL_XCODE_WORKSPACE and CODEX_GATEWAY_EVAL_XCODE_SCHEME for Apple acceptance')
    assert(info?.appleDevelopment?.ready === true && info.appleDevelopment.simulatorReady === true, 'Apple simulator readiness probe failed')

    const workspacePath = resolve(selectedInfo.root, xcodeWorkspace)
    const simulatorList = await rpc('tool_call', {
      workspace: selectedWorkspace,
      name: 'exec_readonly',
      arguments: { command: 'xcodebuildmcp', args: ['simulator', 'list'], timeoutMs: 30_000, yieldTimeMs: 10_000 },
    })
    assert(simulatorList.isError !== true && simulatorList.structuredContent?.exitCode === 0, 'XcodeBuildMCP simulator discovery failed')

    const schemeList = await rpc('tool_call', {
      workspace: selectedWorkspace,
      name: 'exec_readonly',
      arguments: { command: 'xcodebuildmcp', args: ['project-discovery', 'list-schemes', '--workspace-path', workspacePath], timeoutMs: 30_000, yieldTimeMs: 10_000 },
    })
    assert(schemeList.isError !== true && schemeList.structuredContent?.exitCode === 0, `XcodeBuildMCP scheme discovery failed: ${JSON.stringify(schemeList)}`)

    if (process.env.CODEX_GATEWAY_EVAL_NATIVE === '1') {
      const build = await runGatewayCommand(selectedWorkspace, 'exec_command', {
        command: 'xcodebuildmcp',
        args: ['simulator', 'build', '--workspace-path', workspacePath, '--scheme', xcodeScheme, '--simulator-name', simulatorName],
        timeoutMs: 300_000,
        yieldTimeMs: 30_000,
        maxOutputChars: 200_000,
        confirmation: true,
      })
      assert(build.isError !== true && build.structuredContent?.exitCode === 0, `Native build failed: ${JSON.stringify(build)}`)

      const testArgs = ['simulator', 'test', '--workspace-path', workspacePath, '--scheme', xcodeScheme, '--simulator-name', simulatorName]
      if (onlyTesting) testArgs.push('--extra-args', `-only-testing:${onlyTesting}`)
      const tests = await runGatewayCommand(selectedWorkspace, 'exec_command', {
        command: 'xcodebuildmcp',
        args: testArgs,
        timeoutMs: 300_000,
        yieldTimeMs: 30_000,
        maxOutputChars: 200_000,
        confirmation: true,
      })
      assert(tests.isError !== true && tests.structuredContent?.exitCode === 0, `Native tests failed: ${JSON.stringify(tests)}`)

      appleAcceptance = {
        simulatorName,
        buildExitCode: build.structuredContent.exitCode,
        testExitCode: tests.structuredContent.exitCode,
      }
    } else {
      appleAcceptance = {
        simulatorSummary: simulatorList.structuredContent.stdout?.split('\n').find((line: string) => line.includes('simulators available')) || null,
        schemeList: schemeList.structuredContent.stdout || null,
      }
    }
  }

  const unsafeWithoutConfirmation = await rpc('tool_call', {
    workspace: 'codex-gateway',
    name: 'exec_command',
    arguments: { command: 'node', args: ['--version'] },
  })
  assert(unsafeWithoutConfirmation.isError === true && unsafeWithoutConfirmation.structuredContent?.error?.code === 'confirmation_required', 'General execution did not require confirmation')

  const events = (await rpc('tool_call', { workspace: 'codex-gateway', name: 'codex_list_events', arguments: { limit: 10 } })).structuredContent
  const pendingRequests = (await rpc('tool_call', { workspace: 'codex-gateway', name: 'codex_list_pending_requests', arguments: {} })).structuredContent

  console.log(JSON.stringify({
    permissionRoot,
    workspaceCount: workspaceNames.length,
    checkedWorkspaces: [...new Set(['codex-gateway', selectedWorkspace])],
    codex: info.codex,
    appleDevelopment: info.appleDevelopment,
    appleAcceptance,
    bufferedCodexEvents: events.events?.length || 0,
    pendingCodexHostRequests: pendingRequests.requests?.length || 0,
    timingsMs: timings,
    ok: true,
  }, null, 2))
} finally {
  child.kill()
}

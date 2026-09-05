#!/usr/bin/env bun

import { resolve } from 'node:path'

const [permissionRootArg, workspace, toolName, argumentsJson = '{}'] = process.argv.slice(2)
if (!permissionRootArg || !workspace || !toolName) {
  console.error('Usage: bun run scripts/invoke.ts <permission-root> <workspace> <tool> [arguments-json]')
  process.exit(2)
}

const projectRoot = resolve(import.meta.dir, '..')
const permissionRoot = permissionRootArg === 'github' ? resolve(projectRoot, '..') : resolve(permissionRootArg)
let toolArguments: Record<string, unknown>
try {
  toolArguments = JSON.parse(argumentsJson)
} catch (error) {
  console.error(`Invalid arguments JSON: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}

const child = Bun.spawn(['bun', 'run', 'src/server.mjs', '--transport', 'stdio'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    CODEX_GATEWAY_ROOT: permissionRoot,
    CODEX_GATEWAY_ENABLE_CODEX: '1',
    CODEX_GATEWAY_ALLOW_COMMANDS: '1',
    CODEX_GATEWAY_ALLOW_WRITES: '1',
    CODEX_GATEWAY_ALLOW_CODEX_MUTATIONS: '1',
  },
  stdin: 'pipe', stdout: 'pipe', stderr: 'inherit',
})

const request = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: {
    name: 'tool_call',
    arguments: { workspace, name: toolName, arguments: toolArguments },
  },
}

child.stdin.write(`${JSON.stringify(request)}\n`)
await child.stdin.flush()
const reader = child.stdout.getReader()
const decoder = new TextDecoder()
let buffer = ''
try {
  while (true) {
    const newline = buffer.indexOf('\n')
    if (newline >= 0) {
      const message = JSON.parse(buffer.slice(0, newline))
      console.log(JSON.stringify(message.result, null, 2))
      process.exit(message.result?.isError === true ? 1 : 0)
    }
    const next = await reader.read()
    if (next.done) throw new Error('Gateway exited before responding')
    buffer += decoder.decode(next.value, { stream: true })
  }
} finally {
  child.kill()
}

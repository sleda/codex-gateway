import { describe, expect, test } from 'bun:test'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDynamicTools, classifyCodexMethod, createCodexProtocolCatalog, dynamicToolName, parseClientRequestSchema } from '../src/codex-protocol.mjs'

const annotations = {
  readOnlyAnnotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  mutationAnnotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}

const schema = {
  definitions: {
    ThreadItemsListParams: {
      type: 'object',
      properties: { threadId: { type: 'string' }, limit: { type: ['integer', 'null'] } },
      required: ['threadId'],
      additionalProperties: false,
    },
    TurnSteerParams: {
      type: 'object',
      properties: { threadId: { type: 'string' }, expectedTurnId: { type: 'string' }, input: { type: 'array' } },
      required: ['threadId', 'expectedTurnId', 'input'],
      additionalProperties: false,
    },
  },
  oneOf: [
    {
      title: 'InitializeRequest',
      required: ['id', 'method', 'params'],
      properties: { method: { enum: ['initialize'] }, params: { type: 'object' } },
    },
    {
      title: 'Thread/items/listRequest',
      description: 'Page persisted thread items.',
      required: ['id', 'method', 'params'],
      properties: { method: { enum: ['thread/items/list'] }, params: { $ref: '#/definitions/ThreadItemsListParams' } },
    },
    {
      title: 'Turn/steerRequest',
      required: ['id', 'method', 'params'],
      properties: { method: { enum: ['turn/steer'] }, params: { $ref: '#/definitions/TurnSteerParams' } },
    },
    {
      title: 'Account/logoutRequest',
      required: ['id', 'method'],
      properties: { method: { enum: ['account/logout'] } },
    },
  ],
}

describe('Codex protocol discovery', () => {
  test('parses the generated ClientRequest catalog and ignores initialize', () => {
    const methods = parseClientRequestSchema(schema)
    expect(methods.map((entry) => entry.method)).toEqual(['account/logout', 'thread/items/list', 'turn/steer'])
    expect(methods.find((entry) => entry.method === 'thread/items/list')?.inputSchema.properties.threadId.type).toBe('string')
    expect(methods.find((entry) => entry.method === 'account/logout')?.paramsMode).toBe('optional')
  })

  test('defaults unknown methods to mutation and recognizes safe reads', () => {
    expect(classifyCodexMethod('thread/items/list')).toEqual({ readOnly: true, risk: 'read-only' })
    expect(classifyCodexMethod('turn/steer')).toEqual({ readOnly: false, risk: 'agent-execution' })
    expect(classifyCodexMethod('brand/new/action').readOnly).toBe(false)
  })

  test('turns protocol methods into discoverable tools with confirmation on mutations', () => {
    const methods = parseClientRequestSchema(schema)
    const tools = buildDynamicTools({ version: 'codex-cli 0.153.1', methods }, annotations)
    const readTool = tools.find((tool) => tool.name === dynamicToolName('thread/items/list'))!
    const mutationTool = tools.find((tool) => tool.name === dynamicToolName('turn/steer'))!

    expect(readTool.annotations.readOnlyHint).toBe(true)
    expect(readTool.inputSchema.required).toEqual(['threadId'])
    expect(mutationTool.annotations.readOnlyHint).toBe(false)
    const confirmationField = mutationTool.codexProtocol.confirmationField
    expect(confirmationField).toMatch(/^__gatewayConfirmation/)
    expect(mutationTool.inputSchema.properties[confirmationField].type).toBe('boolean')
    expect(mutationTool.inputSchema.required).toContain(confirmationField)
  })

  test('reuses a fingerprinted disk catalog and regenerates after the Codex executable changes', async () => {
    const directory = join(tmpdir(), `codex-gateway-protocol-${process.pid}-${Date.now()}`)
    const executable = join(directory, 'fake-codex')
    const cacheDirectory = join(directory, 'cache')
    await mkdir(directory, { recursive: true })

    const script = (version: string, methodNames: string[]) => `#!/usr/bin/env bun\nimport { mkdir, writeFile } from 'node:fs/promises'\nconst args = process.argv.slice(2)\nif (args.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0) }\nconst outIndex = args.indexOf('--out')\nif (outIndex < 0) process.exit(2)\nconst out = args[outIndex + 1]\nawait mkdir(out, { recursive: true })\nconst methods = ${JSON.stringify(methodNames)}\nconst oneOf = methods.map((method) => ({ required: ['id', 'method'], properties: { method: { enum: [method] } } }))\nawait writeFile(out + '/ClientRequest.json', JSON.stringify({ oneOf }))\n`

    try {
      await writeFile(executable, script('codex-cli 1.0.0', ['model/list']))
      await chmod(executable, 0o755)
      const env = { ...process.env, CODEX_GATEWAY_PROTOCOL_CACHE_DIR: cacheDirectory }
      const first = createCodexProtocolCatalog({ command: executable, cwd: directory, env })
      const generated = await first.load()
      expect(generated.cacheSource).toBe('generated')
      expect(generated.methodCount).toBe(1)

      const second = createCodexProtocolCatalog({ command: executable, cwd: directory, env })
      const fromDisk = await second.load()
      expect(fromDisk.cacheSource).toBe('disk')
      expect(fromDisk.schemaHash).toBe(generated.schemaHash)

      await writeFile(executable, script('codex-cli 1.0.1', ['model/list', 'project/list']))
      await chmod(executable, 0o755)
      const refreshed = await second.load()
      expect(refreshed.cacheSource).toBe('generated')
      expect(refreshed.version).toBe('codex-cli 1.0.1')
      expect(refreshed.methodCount).toBe(2)
      expect(refreshed.schemaHash).not.toBe(generated.schemaHash)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const EMPTY_SCHEMA = { type: 'object', properties: {}, additionalProperties: false }
const SCHEMA_TIMEOUT_MS = 30_000
const PROTOCOL_CACHE_VERSION = 1

function protocolCacheDirectory(env = process.env) {
  return resolve(env.CODEX_GATEWAY_PROTOCOL_CACHE_DIR?.trim() || join(homedir(), '.cache', 'codex-gateway', 'protocol'))
}

function protocolCachePath(fingerprint, env = process.env) {
  const key = createHash('sha256').update(`v${PROTOCOL_CACHE_VERSION}:${fingerprint}`).digest('hex').slice(0, 32)
  return join(protocolCacheDirectory(env), `${key}.json`)
}

async function readPersistentCatalog(fingerprint, env = process.env) {
  try {
    const parsed = JSON.parse(await readFile(protocolCachePath(fingerprint, env), 'utf8'))
    if (parsed?.cacheVersion !== PROTOCOL_CACHE_VERSION || parsed?.fingerprint !== fingerprint || !Array.isArray(parsed?.methods)) return null
    return parsed
  } catch {
    return null
  }
}

async function writePersistentCatalog(catalog, env = process.env) {
  const directory = protocolCacheDirectory(env)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const pathname = protocolCachePath(catalog.fingerprint, env)
  const temporary = `${pathname}.${process.pid}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify({ cacheVersion: PROTOCOL_CACHE_VERSION, ...catalog })}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, pathname)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function failure(message, code = 'codex_protocol_error', extra = {}) {
  const cause = new Error(message)
  cause.code = code
  Object.assign(cause, extra)
  return cause
}

async function run(command, args, { cwd = process.cwd(), env = process.env, timeoutMs = SCHEMA_TIMEOUT_MS } = {}) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, env, shell: false })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolvePromise({ ...result, stdout, stderr })
    }
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref()
      finish({ exitCode: null, signal: 'SIGTERM', timedOut: true })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (cause) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      rejectPromise(failure(`Failed to start ${basename(command)}: ${cause.message}`, 'codex_protocol_command_failed'))
    })
    child.on('close', (exitCode, signal) => finish({ exitCode, signal, timedOut: false }))
  })
}

async function findFile(directory, filename, depth = 0) {
  if (depth > 4) return null
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const pathname = join(directory, entry.name)
    if (entry.isFile() && entry.name === filename) return pathname
    if (entry.isDirectory()) {
      const nested = await findFile(pathname, filename, depth + 1)
      if (nested) return nested
    }
  }
  return null
}

function refName(reference) {
  const match = /^#\/(?:definitions|\$defs)\/(.+)$/.exec(reference || '')
  return match?.[1] || null
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function schemaAllowsNull(schema) {
  if (!schema) return true
  if (schema.type === 'null') return true
  if (Array.isArray(schema.type) && schema.type.includes('null')) return true
  return Array.isArray(schema.anyOf) && schema.anyOf.some((entry) => schemaAllowsNull(entry))
}

function referencedDefinitionNames(value, names = new Set()) {
  if (!value || typeof value !== 'object') return names
  if (typeof value.$ref === 'string') {
    const name = refName(value.$ref)
    if (name) names.add(name)
  }
  for (const nested of Array.isArray(value) ? value : Object.values(value)) referencedDefinitionNames(nested, names)
  return names
}

function minimalDefinitions(schema, definitions) {
  const selected = {}
  const queue = [...referencedDefinitionNames(schema)]
  const seen = new Set()
  while (queue.length) {
    const name = queue.shift()
    if (!name || seen.has(name) || !definitions?.[name]) continue
    seen.add(name)
    selected[name] = clone(definitions[name])
    for (const dependency of referencedDefinitionNames(definitions[name])) if (!seen.has(dependency)) queue.push(dependency)
  }
  return selected
}

function objectInputSchema(paramsSchema, definitions) {
  if (!paramsSchema || paramsSchema === true || paramsSchema.type === 'null') return clone(EMPTY_SCHEMA)
  let schema = clone(paramsSchema)
  if (schema?.$ref) {
    const name = refName(schema.$ref)
    if (name && definitions?.[name]) schema = clone(definitions[name])
  }
  if (!schema || schema === true) schema = clone(EMPTY_SCHEMA)
  if (schema.type === 'null') schema = clone(EMPTY_SCHEMA)
  if (!schema.type && schema.properties) schema.type = 'object'
  if (schema.type !== 'object' && !schema.oneOf && !schema.anyOf && !schema.allOf) {
    schema = { type: 'object', properties: { value: schema }, required: ['value'], additionalProperties: false }
  }
  const selectedDefinitions = minimalDefinitions(schema, definitions)
  if (Object.keys(selectedDefinitions).length) schema.definitions = selectedDefinitions
  return schema
}

function methodFromVariant(variant) {
  const methodSchema = variant?.properties?.method
  if (typeof methodSchema?.const === 'string') return methodSchema.const
  if (Array.isArray(methodSchema?.enum) && methodSchema.enum.length === 1 && typeof methodSchema.enum[0] === 'string') return methodSchema.enum[0]
  return null
}

function paramsMode(variant) {
  if (!variant?.required?.includes('params')) return 'optional'
  return schemaAllowsNull(variant?.properties?.params) ? 'nullable' : 'required'
}

export function parseClientRequestSchema(schema) {
  const variants = schema?.oneOf || schema?.anyOf
  if (!Array.isArray(variants)) throw failure('ClientRequest.json does not contain a oneOf/anyOf request catalog', 'codex_protocol_schema_invalid')
  const definitions = schema.definitions || schema.$defs || {}
  const methods = []
  for (const variant of variants) {
    const method = methodFromVariant(variant)
    if (!method || method === 'initialize') continue
    const inputSchema = objectInputSchema(variant?.properties?.params, definitions)
    methods.push({
      method,
      title: variant.title || method,
      description: variant.description || '',
      inputSchema,
      paramsMode: paramsMode(variant),
    })
  }
  return methods.sort((left, right) => left.method.localeCompare(right.method))
}

const READ_ONLY_EXACT = new Set([
  'account/read',
  'app/list',
  'apps/installed',
  'collaborationMode/list',
  'config/read',
  'configRequirements/read',
  'environment/info',
  'environment/status',
  'experimentalFeature/list',
  'externalAgentConfig/detect',
  'fuzzyFileSearch',
  'model/list',
  'modelProvider/capabilities/read',
  'permissionProfile/list',
  'plugin/installed',
  'plugin/search',
  'plugin/share/list',
  'plugin/skill/read',
  'server/diagnostics',
  'skills/list',
  'thread/backgroundTerminals/list',
  'thread/goal/get',
  'thread/items/list',
  'thread/list',
  'thread/realtime/listVoices',
  'thread/read',
  'thread/turns/list',
  'windowsSandbox/readiness',
])

export function classifyCodexMethod(method) {
  if (READ_ONLY_EXACT.has(method)) return { readOnly: true, risk: 'read-only' }
  if (/^fs\/(?:read|stat|metadata)/i.test(method)) return { readOnly: true, risk: 'read-only' }
  if (/(?:^|\/)(?:list|read|get|status)$/.test(method)) return { readOnly: true, risk: 'read-only' }
  if (/^(?:turn\/start|turn\/steer|review\/start|thread\/realtime\/start)/.test(method)) return { readOnly: false, risk: 'agent-execution' }
  if (/^(?:account\/|plugin\/|skills\/config\/|config\/|experimentalFeature\/enablement\/|remoteControl\/)/.test(method)) return { readOnly: false, risk: 'configuration' }
  if (/^fs\//.test(method)) return { readOnly: false, risk: 'filesystem-mutation' }
  return { readOnly: false, risk: 'mutation' }
}

export function dynamicToolName(method) {
  return `codex_rpc__${method.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`
}

function addControlProperties(schema, { readOnly }) {
  const value = clone(schema || EMPTY_SCHEMA)
  let confirmationField = null
  const chooseConfirmationField = (properties = {}) => {
    let candidate = '__gatewayConfirmation'
    let suffix = 2
    while (Object.prototype.hasOwnProperty.call(properties, candidate)) candidate = `__gatewayConfirmation${suffix++}`
    return candidate
  }
  if (value.type !== 'object' || value.oneOf || value.anyOf || value.allOf) {
    const properties = { params: value }
    if (!readOnly) {
      confirmationField = chooseConfirmationField(properties)
      properties[confirmationField] = { type: 'boolean', description: 'Codex Gateway mutation confirmation. This field is not forwarded to Codex.' }
    }
    return {
      schema: {
        type: 'object',
        properties,
        ...(!readOnly ? { required: [confirmationField] } : {}),
        additionalProperties: false,
      },
      confirmationField,
    }
  }
  value.properties ||= {}
  if (!readOnly) {
    confirmationField = chooseConfirmationField(value.properties)
    value.properties[confirmationField] = { type: 'boolean', description: 'Codex Gateway mutation confirmation. This field is not forwarded to Codex.' }
    value.required = [...new Set([...(value.required || []), confirmationField])]
  }
  return { schema: value, confirmationField }
}

export function buildDynamicTools(catalog, { readOnlyAnnotations, mutationAnnotations }) {
  return catalog.methods.map((entry) => {
    const policy = classifyCodexMethod(entry.method)
    const controls = addControlProperties(entry.inputSchema, policy)
    return {
      name: dynamicToolName(entry.method),
      description: `${entry.description ? `${entry.description.trim()} ` : ''}Codex app-server RPC: ${entry.method}. Dynamically generated from the installed Codex ${catalog.version || 'runtime'} schema. Risk: ${policy.risk}.`,
      inputSchema: controls.schema,
      annotations: policy.readOnly ? readOnlyAnnotations : mutationAnnotations,
      codexProtocol: { method: entry.method, paramsMode: entry.paramsMode, risk: policy.risk, readOnly: policy.readOnly, confirmationField: controls.confirmationField },
    }
  })
}

async function executableFingerprint(command) {
  try {
    const info = await stat(command)
    return `${resolve(command)}:${info.size}:${Math.trunc(info.mtimeMs)}`
  } catch {
    return command
  }
}

export function createCodexProtocolCatalog({ command, cwd, env = process.env } = {}) {
  let cached = null
  let loading = null

  const actualCommand = () => command || env.CODEX_GATEWAY_CODEX_COMMAND || '/Applications/ChatGPT.app/Contents/Resources/codex'

  async function fingerprint() {
    return await executableFingerprint(actualCommand())
  }

  async function load() {
    const executable = actualCommand()
    const currentFingerprint = await fingerprint()
    if (cached?.fingerprint === currentFingerprint) return cached
    if (loading) return await loading

    loading = (async () => {
      const persistent = await readPersistentCatalog(currentFingerprint, env)
      if (persistent) {
        const { cacheVersion: _cacheVersion, ...catalog } = persistent
        cached = { ...catalog, cacheSource: 'disk' }
        return cached
      }

      const versionResult = await run(executable, ['--version'], { cwd, env, timeoutMs: 10_000 })
      const version = (versionResult.stdout || versionResult.stderr).trim() || 'unknown'
      const directory = await mkdtemp(join(tmpdir(), 'codex-gateway-protocol-'))
      try {
        let generated = await run(executable, ['app-server', 'generate-json-schema', '--out', directory, '--experimental'], { cwd, env })
        let experimental = true
        if (generated.exitCode !== 0) {
          await rm(directory, { recursive: true, force: true })
          await import('node:fs/promises').then(({ mkdir }) => mkdir(directory, { recursive: true }))
          generated = await run(executable, ['app-server', 'generate-json-schema', '--out', directory], { cwd, env })
          experimental = false
        }
        if (generated.exitCode !== 0) {
          throw failure(`Codex schema generation failed: ${(generated.stderr || generated.stdout || `exit ${generated.exitCode}`).trim()}`, 'codex_protocol_generation_failed')
        }
        const clientRequestPath = await findFile(directory, 'ClientRequest.json')
        if (!clientRequestPath) throw failure('Codex schema generation did not produce ClientRequest.json', 'codex_protocol_schema_missing')
        const clientRequestSchema = JSON.parse(await readFile(clientRequestPath, 'utf8'))
        const methods = parseClientRequestSchema(clientRequestSchema)
        const schemaHash = createHash('sha256').update(JSON.stringify(methods)).digest('hex').slice(0, 24)
        cached = {
          fingerprint: currentFingerprint,
          version,
          experimental,
          schemaHash,
          generatedAt: new Date().toISOString(),
          methodCount: methods.length,
          methods,
          cacheSource: 'generated',
        }
        await writePersistentCatalog(cached, env).catch(() => undefined)
        return cached
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })()
    try { return await loading } finally { loading = null }
  }

  function invalidate() { cached = null }
  return { load, fingerprint, invalidate }
}

export { EMPTY_SCHEMA }

function toolSearchScore(tool, needle) {
  if (!needle) return 0
  const name = tool.name.toLowerCase()
  const description = (tool.description || '').toLowerCase()
  const normalizedNeedle = needle.replace(/[^a-z0-9]+/g, '_')
  if (name === needle || name === normalizedNeedle) return 1_000
  if (name.startsWith(needle) || name.startsWith(normalizedNeedle)) return 800
  if (name.includes(needle) || name.includes(normalizedNeedle)) return 600
  const tokens = needle.split(/[^a-z0-9]+/).filter(Boolean)
  if (tokens.length && tokens.every((token) => name.includes(token))) return 500 + tokens.length
  if (tokens.length && tokens.every((token) => `${name} ${description}`.includes(token))) return 300 + tokens.length
  if (description.includes(needle)) return 200
  return -1
}

export function createGateway({
  localTools,
  emptySchema,
  readOnlyAnnotations,
  mutationAnnotations,
  capabilityReport,
  allTools,
  callTool,
  searchSkills,
  readSkill,
  structuredResult,
  error,
}) {
  const goalMutationAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  const gatewayTools = [
    { name: 'gateway_info', description: 'Report the live workspace and core Codex capabilities behind this gateway.', inputSchema: emptySchema, annotations: readOnlyAnnotations },
    {
      name: 'tool_search',
      description: 'Search the live core Codex tool catalog. Matching schemas are loaded only for this result page.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, includeSchema: { type: 'boolean' } }, additionalProperties: false },
      annotations: readOnlyAnnotations,
    },
    {
      name: 'tool_call',
      description: 'Invoke an exact tool name returned by tool_search. Local policy flags and per-call confirmation remain authoritative.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object', additionalProperties: true }, workspace: { type: 'string', description: 'Optional granted workspace selector for this call.' } }, required: ['name'], additionalProperties: false },
      annotations: mutationAnnotations,
    },
    {
      name: 'tool_batch',
      description: 'Run up to 16 independent read-only tools concurrently. Use only when calls do not depend on each other; keep mutations and dependent steps sequential.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: { type: 'string', description: 'Optional granted workspace selector shared by the batch.' },
          calls: {
            type: 'array', minItems: 1, maxItems: 16,
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } },
              required: ['name'], additionalProperties: false,
            },
          },
        },
        required: ['calls'], additionalProperties: false,
      },
      annotations: readOnlyAnnotations,
    },
    {
      name: 'skill_search',
      description: 'Search installed Codex skills by name and description without loading their instructions.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, includeAlternatives: { type: 'boolean' }, refresh: { type: 'boolean', description: 'Force a synchronous skill catalog refresh instead of using the persistent cache.' }, workspace: { type: 'string', description: 'Optional granted workspace whose workspace-local skills should be searched.' } }, additionalProperties: false },
      annotations: readOnlyAnnotations,
    },
    {
      name: 'skill_read',
      description: 'Load one discovered skill entrypoint or a relative supporting resource only when it is needed.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, resource: { type: 'string' }, workspace: { type: 'string', description: 'Optional granted workspace used to resolve this skill id.' } }, required: ['id'], additionalProperties: false },
      annotations: readOnlyAnnotations,
    },
    { name: 'create_goal', description: 'Create a persistent goal for a granted workspace and continue working on it in the current assistant turn. Fails while another goal is active in that workspace.', inputSchema: { type: 'object', properties: { objective: { type: 'string', minLength: 1 }, tokenBudget: { type: 'integer', minimum: 1 }, workspace: { type: 'string', description: 'Optional granted workspace selector.' } }, required: ['objective'], additionalProperties: false }, annotations: goalMutationAnnotations },
    { name: 'get_goal', description: 'Read the persistent goal and continuation instructions for a granted workspace, including its latest checkpoint.', inputSchema: { type: 'object', properties: { workspace: { type: 'string', description: 'Optional granted workspace selector.' } }, additionalProperties: false }, annotations: readOnlyAnnotations },
    { name: 'update_goal', description: 'Update the current workspace goal status and checkpoint. An active result instructs the Web model to continue in the same assistant turn.', inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['active', 'complete', 'blocked'] }, summary: { type: 'string' }, nextSteps: { type: 'array', items: { type: 'string' }, maxItems: 20 }, workspace: { type: 'string', description: 'Optional granted workspace selector.' } }, required: ['status'], additionalProperties: false }, annotations: goalMutationAnnotations },
    { name: 'clear_goal', description: 'Remove the persistent goal for a granted workspace.', inputSchema: { type: 'object', properties: { workspace: { type: 'string', description: 'Optional granted workspace selector.' } }, additionalProperties: false }, annotations: mutationAnnotations },
  ]

  async function callGatewayTool(name, args = {}) {
    if (name === 'gateway_info') return structuredResult(await capabilityReport())
    if (name === 'tool_search') {
      const tools = await allTools()
      const needle = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
      const matches = tools
        .map((tool, catalogIndex) => ({ tool, catalogIndex, score: toolSearchScore(tool, needle) }))
        .filter((entry) => !needle || entry.score >= 0)
        .sort((left, right) => needle ? right.score - left.score || left.tool.name.localeCompare(right.tool.name) : left.catalogIndex - right.catalogIndex)
      const offset = Math.min(Math.max(args.offset || 0, 0), matches.length)
      const limit = Math.min(Math.max(args.limit || 20, 1), 100)
      const rawPage = matches.slice(offset, offset + limit)
      const includeSchema = args.includeSchema ?? rawPage.length <= 5
      const page = rawPage.map(({ tool, score }) => ({
        name: tool.name,
        description: tool.description || tool.name,
        annotations: tool.annotations || null,
        ...(needle ? { matchScore: score } : {}),
        ...(tool.codexProtocol ? { codexProtocol: tool.codexProtocol } : {}),
        ...(includeSchema ? { inputSchema: tool.inputSchema } : {}),
      }))
      return structuredResult({ tools: page, total: matches.length, schemasIncluded: includeSchema, nextOffset: offset + page.length < matches.length ? offset + page.length : null })
    }
    if (name === 'tool_call') {
      if (typeof args.name !== 'string' || !args.name) throw error('name is required')
      if (['gateway_info', 'tool_search', 'tool_call', 'skill_search', 'skill_read'].includes(args.name)) throw error('Gateway discovery tools cannot be invoked recursively', 'recursive_gateway_call')
      const forwardedArguments = { ...(args.arguments || {}) }
      const compatibilityWorkspace = typeof forwardedArguments.__gatewayWorkspace === 'string'
        ? forwardedArguments.__gatewayWorkspace
        : undefined
      delete forwardedArguments.__gatewayWorkspace
      return await callTool(args.name, forwardedArguments, { workspace: args.workspace ?? compatibilityWorkspace })
    }
    if (name === 'tool_batch') return await callTool('tool_batch', args, { workspace: args.workspace })
    if (name === 'skill_search') return structuredResult(await searchSkills(args))
    if (name === 'skill_read') return structuredResult(await readSkill(args))
    if (['create_goal', 'get_goal', 'update_goal', 'clear_goal'].includes(name)) {
      const { workspace, ...goalArgs } = args
      return await callTool(name, goalArgs, { workspace })
    }
    throw error(`Unknown gateway tool: ${name}`, 'unknown_tool')
  }

  return { gatewayTools, callGatewayTool }
}

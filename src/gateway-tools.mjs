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
      inputSchema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, required: ['name'], additionalProperties: false },
      annotations: mutationAnnotations,
    },
    {
      name: 'skill_search',
      description: 'Search installed Codex skills by name and description without loading their instructions.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
      annotations: readOnlyAnnotations,
    },
    {
      name: 'skill_read',
      description: 'Load one discovered skill entrypoint or a relative supporting resource only when it is needed.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, resource: { type: 'string' } }, required: ['id'], additionalProperties: false },
      annotations: readOnlyAnnotations,
    },
  ]

  async function callGatewayTool(name, args = {}) {
    if (name === 'gateway_info') return structuredResult(await capabilityReport())
    if (name === 'tool_search') {
      const tools = await allTools()
      const needle = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
      const matches = tools.filter((tool) => !needle || `${tool.name}\n${tool.description || ''}`.toLowerCase().includes(needle))
      const offset = Math.min(Math.max(args.offset || 0, 0), matches.length)
      const limit = Math.min(Math.max(args.limit || 20, 1), 100)
      const page = matches.slice(offset, offset + limit).map((tool) => ({
        name: tool.name,
        description: tool.description || tool.name,
        annotations: tool.annotations || null,
        ...(args.includeSchema === false ? {} : { inputSchema: tool.inputSchema }),
      }))
      return structuredResult({ tools: page, total: matches.length, nextOffset: offset + page.length < matches.length ? offset + page.length : null })
    }
    if (name === 'tool_call') {
      if (typeof args.name !== 'string' || !args.name) throw error('name is required')
      if (gatewayTools.some((tool) => tool.name === args.name)) throw error('Gateway tools cannot be invoked recursively', 'recursive_gateway_call')
      return await callTool(args.name, args.arguments || {})
    }
    if (name === 'skill_search') return structuredResult(await searchSkills(args))
    if (name === 'skill_read') return structuredResult(await readSkill(args))
    throw error(`Unknown gateway tool: ${name}`, 'unknown_tool')
  }

  return { gatewayTools, callGatewayTool }
}

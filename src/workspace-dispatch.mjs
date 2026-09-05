// These discovered tools deliberately fit the original tool_call(name, arguments)
// ABI. A connector with cached public schemas can select a workspace immediately.
// They select an existing grant; they never create grants or change global state.
const BLOCKED_TARGETS = new Set([
  'workspace_call', 'workspace_batch', 'tool_call', 'tool_batch',
  'gateway_info', 'tool_search', 'skill_search', 'skill_read',
])

function invalid(message, code = 'invalid_request') {
  return Object.assign(new Error(message), { code })
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function workspaceDispatchTools({ readOnlyAnnotations, mutationAnnotations }) {
  return [
    {
      name: 'workspace_call',
      description: 'Call a discovered tool in a granted workspace. Compatible with cached tool_call(name, arguments) schemas: put workspace, name, and arguments inside this tool\'s arguments. Does not change the default workspace. Target permissions and confirmations are enforced unchanged.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: { type: 'string', minLength: 1 },
          name: { type: 'string', minLength: 1 },
          arguments: { type: 'object', additionalProperties: true },
        },
        required: ['workspace', 'name'], additionalProperties: false,
      },
      annotations: mutationAnnotations,
    },
    {
      name: 'workspace_batch',
      description: 'Run independent read-only discovered tools in one granted workspace using the cached tool_call ABI. Mutations, media, and recursive dispatch are rejected.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: { type: 'string', minLength: 1 },
          calls: {
            type: 'array', minItems: 1, maxItems: 16,
            items: {
              type: 'object',
              properties: { name: { type: 'string', minLength: 1 }, arguments: { type: 'object', additionalProperties: true } },
              required: ['name'], additionalProperties: false,
            },
          },
        },
        required: ['workspace', 'calls'], additionalProperties: false,
      },
      annotations: readOnlyAnnotations,
    },
  ]
}

export async function dispatchWorkspaceTool(kind, input, callTool) {
  if (!object(input) || typeof input.workspace !== 'string' || !input.workspace.trim()) {
    throw invalid('A non-empty granted workspace selector is required', 'invalid_workspace')
  }
  if (kind !== 'workspace_call' && kind !== 'workspace_batch') throw invalid('Unknown workspace dispatcher', 'unknown_tool')
  const allowedKeys = new Set(kind === 'workspace_call' ? ['workspace', 'name', 'arguments'] : ['workspace', 'calls'])
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) throw invalid('Unexpected workspace dispatcher argument')
  const validateEntry = (entry) => {
    if (!object(entry) || typeof entry.name !== 'string' || !entry.name.trim()) throw invalid('A target tool name is required')
    if (BLOCKED_TARGETS.has(entry.name)) throw invalid('Recursive workspace/discovery dispatch is not supported', 'recursive_gateway_call')
    if (entry.arguments !== undefined && !object(entry.arguments)) throw invalid('Tool arguments must be an object')
  }
  const context = { workspace: input.workspace }
  if (kind === 'workspace_call') {
    validateEntry(input)
    // Return the target MCP envelope intact, preserving image content and errors.
    return await callTool(input.name, input.arguments ?? {}, context)
  }
  if (!Array.isArray(input.calls) || input.calls.length < 1 || input.calls.length > 16) {
    throw invalid('calls must contain between 1 and 16 entries')
  }
  for (const entry of input.calls) {
    validateEntry(entry)
    if (Object.keys(entry).some((key) => key !== 'name' && key !== 'arguments')) throw invalid('Unexpected batch entry argument')
  }
  // The existing batch implementation validates every target before execution.
  return await callTool('tool_batch', { calls: input.calls }, context)
}

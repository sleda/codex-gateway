const DEFAULT_MAX_RESULT_CHARS = 40_000

function serialize(value, pretty = false) {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, pretty ? 2 : 0)
}

function continuationMetadata(value, depth = 0, path = '') {
  if (!value || typeof value !== 'object' || depth > 3) return []
  const keys = new Set(['nextCursor', 'backwardsCursor', 'nextOffset', 'cursor', 'offset', 'total', 'count', 'latestSequence', 'nextSequence'])
  const results = []
  for (const [key, nested] of Object.entries(value)) {
    const currentPath = path ? `${path}.${key}` : key
    if (keys.has(key) && (nested === null || ['string', 'number', 'boolean'].includes(typeof nested))) results.push({ path: currentPath, value: nested })
    else if (nested && typeof nested === 'object' && !Array.isArray(nested)) results.push(...continuationMetadata(nested, depth + 1, currentPath))
  }
  return results.slice(0, 32)
}

export function createStructuredResult(value, maxChars = DEFAULT_MAX_RESULT_CHARS) {
  const compact = serialize(value)
  const text = serialize(value, true)
  const oversized = compact.length > maxChars

  return {
    content: [{
      type: 'text',
      text: text.length > maxChars ? `${text.slice(0, maxChars)}\n… output truncated …` : text,
    }],
    structuredContent: oversized
      ? {
          truncated: true,
          originalChars: compact.length,
          continuation: continuationMetadata(value),
          message: 'Full structured payload omitted; use a smaller page or narrower tool arguments.',
        }
      : value,
    isError: false,
  }
}

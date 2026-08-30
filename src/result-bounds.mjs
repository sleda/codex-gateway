const DEFAULT_MAX_RESULT_CHARS = 40_000

function serialize(value, pretty = false) {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, pretty ? 2 : 0)
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
          message: 'Full structured payload omitted; use a smaller page or narrower tool arguments.',
        }
      : value,
    isError: false,
  }
}

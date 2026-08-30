import { describe, expect, test } from 'bun:test'
import { createStructuredResult } from '../src/result-bounds.mjs'

describe('structured MCP result bounds', () => {
  test('does not duplicate oversized provider payloads into structuredContent', () => {
    const payload = { turns: [{ output: 'x'.repeat(11 * 1024 * 1024) }] }
    const result = createStructuredResult(payload)
    const encoded = JSON.stringify(result)

    expect(Buffer.byteLength(encoded)).toBeLessThan(1 * 1024 * 1024)
    expect(result.structuredContent).toEqual({
      truncated: true,
      originalChars: JSON.stringify(payload).length,
      message: 'Full structured payload omitted; use a smaller page or narrower tool arguments.',
    })
    expect(result.content[0].text).toContain('output truncated')
  })

  test('preserves small structured payloads', () => {
    const payload = { ok: true, tools: ['gateway_info'] }
    const result = createStructuredResult(payload)

    expect(result.structuredContent).toEqual(payload)
  })
})

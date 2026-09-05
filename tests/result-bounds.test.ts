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
      continuation: [],
      message: 'Full structured payload omitted; use a smaller page or narrower tool arguments.',
    })
    expect(result.content[0].text).toContain('output truncated')
  })

  test('preserves continuation cursors even when the full payload is bounded', () => {
    const payload = { data: [{ output: 'x'.repeat(100_000) }], nextCursor: 'page-2', nested: { nextOffset: 20 } }
    const result = createStructuredResult(payload, 1_000)

    expect(result.structuredContent.truncated).toBe(true)
    expect(result.structuredContent.continuation).toEqual(expect.arrayContaining([
      { path: 'nextCursor', value: 'page-2' },
      { path: 'nested.nextOffset', value: 20 },
    ]))
  })

  test('preserves small structured payloads', () => {
    const payload = { ok: true, tools: ['gateway_info'] }
    const result = createStructuredResult(payload)

    expect(result.structuredContent).toEqual(payload)
  })
})

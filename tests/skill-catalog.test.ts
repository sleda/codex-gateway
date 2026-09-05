import { describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchSkills } from '../src/skill-catalog.mjs'

const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`

describe('skill discovery', () => {
  test('deduplicates logical skill names by default and preserves alternatives on demand', async () => {
    const root = join(tmpdir(), `codex-gateway-skills-${process.pid}-${Date.now()}`)
    await mkdir(join(root, 'a'), { recursive: true })
    await mkdir(join(root, 'b'), { recursive: true })
    try {
      await writeFile(join(root, 'a', 'SKILL.md'), skill('agents-sdk', 'First copy'))
      await writeFile(join(root, 'b', 'SKILL.md'), skill('agents-sdk', 'Second copy'))
      const env = { ...process.env, CODEX_GATEWAY_SKILL_ROOTS: root }

      const canonical = await searchSkills('/workspace', { query: 'agents-sdk' }, env)
      expect(canonical.total).toBe(1)
      expect(canonical.rawTotal).toBe(2)
      expect(canonical.skills[0].alternatives).toBe(1)
      expect(canonical.skills[0].alternativeIds).toHaveLength(1)

      const expanded = await searchSkills('/workspace', { query: 'agents-sdk', includeAlternatives: true }, env)
      expect(expanded.total).toBe(2)
      expect(expanded.deduplicated).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

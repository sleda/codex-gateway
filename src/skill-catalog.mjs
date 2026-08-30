import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const MAX_SKILL_BYTES = 256 * 1024
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules'])

function parseFrontmatter(content) {
  const match = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(content)
  if (!match) return null
  const value = (key) => {
    const line = match[1].split('\n').find((entry) => entry.startsWith(`${key}:`))
    if (!line) return null
    return line.slice(key.length + 1).trim().replace(/^(["'])(.*)\1$/, '$2')
  }
  const name = value('name')
  const description = value('description')
  return name && description ? { name, description } : null
}

function inside(root, candidate) {
  const relation = relative(root, candidate)
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
}

async function walk(directory, filename, results, depth = 0) {
  if (depth > 10) return
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const pathname = join(directory, entry.name)
    if (entry.isFile() && entry.name === filename) results.push(pathname)
    else if (entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name)) await walk(pathname, filename, results, depth + 1)
  }
}

function configuredRoots(workspaceRoot, env) {
  const configured = env.CODEX_GATEWAY_SKILL_ROOTS?.split(/[,:]/).map((item) => item.trim()).filter(Boolean)
  if (configured?.length) return configured.map((path) => ({ source: 'configured', path: resolve(path) }))
  const codexHome = resolve(env.CODEX_HOME?.trim() || join(homedir(), '.codex'))
  return [
    { source: 'workspace', path: join(workspaceRoot, '.agents', 'skills') },
    { source: 'user', path: join(homedir(), '.agents', 'skills') },
    { source: 'codex', path: join(codexHome, 'skills') },
    { source: 'plugin', path: join(codexHome, 'plugins', 'cache') },
  ]
}

export async function createSkillCatalog(workspaceRoot, env = process.env) {
  const skills = []
  const seenPaths = new Set()
  for (const root of configuredRoots(workspaceRoot, env)) {
    const files = []
    await walk(root.path, 'SKILL.md', files)
    for (const skillPath of files) {
      let canonicalPath
      try { canonicalPath = await realpath(skillPath) } catch { continue }
      if (seenPaths.has(canonicalPath)) continue
      seenPaths.add(canonicalPath)
      const info = await stat(canonicalPath)
      if (!info.isFile() || info.size > MAX_SKILL_BYTES) continue
      const content = await readFile(canonicalPath, 'utf8')
      const metadata = parseFrontmatter(content)
      if (!metadata) continue
      const directory = dirname(canonicalPath)
      skills.push({
        id: createHash('sha256').update(directory).digest('hex').slice(0, 16),
        ...metadata,
        source: root.source,
        directory,
      })
    }
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name) || left.source.localeCompare(right.source))
}

export async function searchSkills(workspaceRoot, input = {}, env = process.env) {
  const catalog = await createSkillCatalog(workspaceRoot, env)
  const needle = typeof input.query === 'string' ? input.query.trim().toLowerCase() : ''
  const matches = catalog.filter((skill) => !needle || `${skill.name}\n${skill.description}`.toLowerCase().includes(needle))
  const offset = Math.min(Math.max(input.offset || 0, 0), matches.length)
  const limit = Math.min(Math.max(input.limit || 20, 1), 100)
  const page = matches.slice(offset, offset + limit).map(({ directory: _directory, ...skill }) => skill)
  return { skills: page, total: matches.length, nextOffset: offset + page.length < matches.length ? offset + page.length : null }
}

export async function readSkill(workspaceRoot, input = {}, env = process.env) {
  if (typeof input.id !== 'string' || !input.id) throw Object.assign(new Error('id is required'), { code: 'invalid_request' })
  const skill = (await createSkillCatalog(workspaceRoot, env)).find((entry) => entry.id === input.id)
  if (!skill) throw Object.assign(new Error(`Unknown skill id: ${input.id}`), { code: 'unknown_skill' })
  const resource = typeof input.resource === 'string' && input.resource.trim() ? input.resource.trim() : 'SKILL.md'
  if (isAbsolute(resource)) throw Object.assign(new Error('resource must be relative to the skill directory'), { code: 'invalid_resource' })
  const candidate = resolve(skill.directory, resource)
  if (!inside(skill.directory, candidate)) throw Object.assign(new Error('resource must stay inside the skill directory'), { code: 'invalid_resource' })
  const canonical = await realpath(candidate)
  if (!inside(skill.directory, canonical)) throw Object.assign(new Error('resource symlink leaves the skill directory'), { code: 'invalid_resource' })
  const info = await stat(canonical)
  if (!info.isFile() || info.size > MAX_SKILL_BYTES) throw Object.assign(new Error('skill resource is unavailable or too large'), { code: 'invalid_resource' })
  return {
    skill: { id: skill.id, name: skill.name, description: skill.description, source: skill.source },
    resource,
    content: await readFile(canonical, 'utf8'),
  }
}

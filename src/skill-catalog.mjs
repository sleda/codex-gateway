import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const MAX_SKILL_BYTES = 256 * 1024
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules'])
const SKILL_CACHE_VERSION = 1
const DEFAULT_SKILL_CACHE_TTL_MS = 60_000
const catalogCache = new Map()

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

function skillCacheDirectory(env) {
  return resolve(env.CODEX_GATEWAY_SKILL_CACHE_DIR?.trim() || join(homedir(), '.cache', 'codex-gateway', 'skills'))
}

function skillCacheKey(workspaceRoot, env) {
  const roots = configuredRoots(workspaceRoot, env)
  return createHash('sha256')
    .update(JSON.stringify({ version: SKILL_CACHE_VERSION, workspaceRoot: resolve(workspaceRoot), roots }))
    .digest('hex')
    .slice(0, 32)
}

function skillCachePath(workspaceRoot, env) {
  return join(skillCacheDirectory(env), `${skillCacheKey(workspaceRoot, env)}.json`)
}

function skillCacheTtlMs(env) {
  const configured = Number(env.CODEX_GATEWAY_SKILL_CACHE_TTL_MS || DEFAULT_SKILL_CACHE_TTL_MS)
  return Number.isFinite(configured) ? Math.min(Math.max(configured, 5_000), 86_400_000) : DEFAULT_SKILL_CACHE_TTL_MS
}

async function scanSkillCatalog(workspaceRoot, env) {
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

async function readPersistentCatalog(workspaceRoot, env) {
  const key = skillCacheKey(workspaceRoot, env)
  try {
    const parsed = JSON.parse(await readFile(skillCachePath(workspaceRoot, env), 'utf8'))
    if (parsed?.cacheVersion !== SKILL_CACHE_VERSION || parsed?.key !== key || !Array.isArray(parsed?.catalog)) return null
    return { catalog: parsed.catalog, updatedAt: Number(parsed.updatedAt) || 0 }
  } catch {
    return null
  }
}

async function writePersistentCatalog(workspaceRoot, env, catalog, updatedAt) {
  const directory = skillCacheDirectory(env)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const pathname = skillCachePath(workspaceRoot, env)
  const temporary = `${pathname}.${process.pid}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify({
      cacheVersion: SKILL_CACHE_VERSION,
      key: skillCacheKey(workspaceRoot, env),
      updatedAt,
      catalog,
    })}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, pathname)
  } finally {
    await import('node:fs/promises').then(({ rm }) => rm(temporary, { force: true }).catch(() => undefined))
  }
}

async function refreshSkillCatalog(workspaceRoot, env) {
  const key = skillCacheKey(workspaceRoot, env)
  const current = catalogCache.get(key)
  if (current?.refreshing) return await current.refreshing

  const refreshing = (async () => {
    const catalog = await scanSkillCatalog(workspaceRoot, env)
    const updatedAt = Date.now()
    catalogCache.set(key, { catalog, updatedAt, refreshing: null })
    await writePersistentCatalog(workspaceRoot, env, catalog, updatedAt).catch(() => undefined)
    return catalog
  })()
  catalogCache.set(key, { catalog: current?.catalog || null, updatedAt: current?.updatedAt || 0, refreshing })
  try { return await refreshing } finally {
    const latest = catalogCache.get(key)
    if (latest?.refreshing === refreshing) catalogCache.set(key, { ...latest, refreshing: null })
  }
}

export async function createSkillCatalog(workspaceRoot, env = process.env, { refresh = false } = {}) {
  if (refresh) return await refreshSkillCatalog(workspaceRoot, env)
  const key = skillCacheKey(workspaceRoot, env)
  let cached = catalogCache.get(key)
  if (!cached?.catalog) {
    const persistent = await readPersistentCatalog(workspaceRoot, env)
    if (persistent) {
      cached = { ...persistent, refreshing: null }
      catalogCache.set(key, cached)
    }
  }
  if (!cached?.catalog) return await refreshSkillCatalog(workspaceRoot, env)

  if (Date.now() - cached.updatedAt > skillCacheTtlMs(env) && !cached.refreshing) {
    void refreshSkillCatalog(workspaceRoot, env).catch(() => undefined)
  }
  return cached.catalog
}

const SOURCE_PRIORITY = new Map([['workspace', 0], ['configured', 0], ['user', 1], ['codex', 2], ['plugin', 3]])

function canonicalSkills(catalog) {
  const groups = new Map()
  for (const skill of catalog) {
    const key = skill.name.trim().toLowerCase()
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(skill)
  }
  return [...groups.values()].map((group) => {
    group.sort((left, right) =>
      (SOURCE_PRIORITY.get(left.source) ?? 9) - (SOURCE_PRIORITY.get(right.source) ?? 9)
      || left.directory.localeCompare(right.directory))
    const selected = group[0]
    return {
      ...selected,
      alternatives: group.length - 1,
      alternativeSources: [...new Set(group.slice(1).map((entry) => entry.source))],
      alternativeIds: group.slice(1).map((entry) => entry.id),
    }
  }).sort((left, right) => left.name.localeCompare(right.name) || left.source.localeCompare(right.source))
}

export async function searchSkills(workspaceRoot, input = {}, env = process.env) {
  const catalog = await createSkillCatalog(workspaceRoot, env, { refresh: input.refresh === true })
  const searchable = input.includeAlternatives === true ? catalog : canonicalSkills(catalog)
  const needle = typeof input.query === 'string' ? input.query.trim().toLowerCase() : ''
  const matches = searchable.filter((skill) => !needle || `${skill.name}\n${skill.description}`.toLowerCase().includes(needle))
  const offset = Math.min(Math.max(input.offset || 0, 0), matches.length)
  const limit = Math.min(Math.max(input.limit || 20, 1), 100)
  const page = matches.slice(offset, offset + limit).map(({ directory: _directory, ...skill }) => skill)
  return {
    skills: page,
    total: matches.length,
    rawTotal: catalog.length,
    deduplicated: input.includeAlternatives !== true,
    nextOffset: offset + page.length < matches.length ? offset + page.length : null,
  }
}

export async function readSkill(workspaceRoot, input = {}, env = process.env) {
  if (typeof input.id !== 'string' || !input.id) throw Object.assign(new Error('id is required'), { code: 'invalid_request' })
  let catalog = await createSkillCatalog(workspaceRoot, env)
  let skill = catalog.find((entry) => entry.id === input.id)
  if (!skill) {
    catalog = await createSkillCatalog(workspaceRoot, env, { refresh: true })
    skill = catalog.find((entry) => entry.id === input.id)
  }
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

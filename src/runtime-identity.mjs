import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

// The build embeds this constant; source execution hashes the same module files.
export const isCompiledRuntime = typeof __CODEX_GATEWAY_BUILD_FINGERPRINT__ !== 'undefined'
const sourceFiles = [
  './server.mjs', './gateway-tools.mjs', './workspace-dispatch.mjs',
  './run-store.mjs', './run-tools.mjs',
  './codex-protocol.mjs', './result-bounds.mjs', './skill-catalog.mjs',
  './runtime-identity.mjs', './cli.mjs', './onboard.mjs', './runtime.mjs', './handover.mjs',
]

export async function sourceFingerprint() {
  if (isCompiledRuntime) return __CODEX_GATEWAY_BUILD_FINGERPRINT__
  const sources = await Promise.all(sourceFiles.map((path) => readFile(new URL(path, import.meta.url), 'utf8')))
  return createHash('sha256').update(sources.join('\u0000')).digest('hex').slice(0, 24)
}

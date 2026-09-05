#!/usr/bin/env bun

import { mkdir } from 'node:fs/promises'
import { sourceFingerprint } from '../src/runtime-identity.mjs'

await mkdir('dist', { recursive: true })
const fingerprint = await sourceFingerprint()
const build = Bun.spawnSync(['bun', 'build', 'src/cli.mjs', '--compile', '--define', `__CODEX_GATEWAY_BUILD_FINGERPRINT__=${JSON.stringify(fingerprint)}`, '--outfile', 'dist/codex-gateway'], {
  stdout: 'inherit', stderr: 'inherit',
})
if (build.exitCode !== 0) process.exit(build.exitCode)

if (process.platform === 'darwin') {
  const sign = Bun.spawnSync(['codesign', '--force', '--sign', '-', 'dist/codex-gateway'], {
    stdout: 'inherit', stderr: 'inherit',
  })
  if (sign.exitCode !== 0) process.exit(sign.exitCode)
}

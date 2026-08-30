#!/usr/bin/env bun

import { mkdir } from 'node:fs/promises'

await mkdir('dist', { recursive: true })
const build = Bun.spawnSync(['bun', 'build', 'src/cli.mjs', '--compile', '--outfile', 'dist/codex-gateway'], {
  stdout: 'inherit', stderr: 'inherit',
})
if (build.exitCode !== 0) process.exit(build.exitCode)

if (process.platform === 'darwin') {
  const sign = Bun.spawnSync(['codesign', '--force', '--sign', '-', 'dist/codex-gateway'], {
    stdout: 'inherit', stderr: 'inherit',
  })
  if (sign.exitCode !== 0) process.exit(sign.exitCode)
}

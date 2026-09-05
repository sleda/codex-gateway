#!/usr/bin/env bun

import packageJson from '../package.json' with { type: 'json' }

const [command = 'help', ...args] = process.argv.slice(2)
const help = `Codex Gateway

Usage:
  codex-gateway onboard [options]     Configure a workspace and managed tunnel runtime
  codex-gateway restart [options]     Restart the workspace tunnel and wait until ready
  codex-gateway handover [options]    Replace the current managed runtime after returning control
  codex-gateway serve [options]       Start the MCP server (stdio by default)
  codex-gateway doctor [--strict]     Check local prerequisites
  codex-gateway version               Print the installed version
  codex-gateway help                  Show this help
`

if (command === 'onboard') {
  const { onboard } = await import('./onboard.mjs')
  await onboard(args)
} else if (command === 'restart') {
  const { restart } = await import('./runtime.mjs')
  await restart(args)
} else if (command === 'handover') {
  const { handover } = await import('./handover.mjs')
  await handover(args)
} else if (command === '__handover-worker') {
  const { runHandoverWorker } = await import('./handover.mjs')
  await runHandoverWorker(args[0])
} else if (command === 'serve') {
  process.argv = [process.argv[0], process.argv[1], ...args]
  await import('./server.mjs')
} else if (command === 'doctor') {
  const { doctor } = await import('./doctor.mjs')
  const result = await doctor({ strict: args.includes('--strict') })
  if (!result.ok) process.exitCode = 1
} else if (command === 'version' || command === '--version' || command === '-v') {
  console.log(packageJson.version)
} else if (command === 'help' || command === '--help' || command === '-h') {
  console.log(help)
} else {
  console.error(`Unknown command: ${command}\n\n${help}`)
  process.exitCode = 2
}

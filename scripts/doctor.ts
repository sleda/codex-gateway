#!/usr/bin/env bun

import { doctor } from '../src/doctor.mjs'

const result = await doctor({ strict: process.argv.includes('--strict') })
if (!result.ok) process.exit(1)

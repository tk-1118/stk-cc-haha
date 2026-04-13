#!/usr/bin/env bun
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')

process.env.CALLER_DIR = process.cwd()
process.chdir(ROOT_DIR)

const args = process.argv.slice(2)
const entry =
  process.env.CLAUDE_CODE_FORCE_RECOVERY_CLI === '1'
    ? './src/localRecoveryCli.ts'
    : './src/entrypoints/cli.tsx'

const proc = Bun.spawn(
  [process.execPath, '--env-file=.env', entry, ...args],
  {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: ['inherit', 'inherit', 'inherit'],
  },
)

const code = await proc.exited
process.exit(code)

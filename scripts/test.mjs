import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

// Explicit argument arrays keep coverage globs and test paths portable to cmd.exe.
const coverage = process.argv.includes('--coverage')
  ? [
      '--experimental-test-coverage', '--test-coverage-include=dist/core/**',
      '--test-coverage-include=dist/providers/**', '--test-coverage-lines=80'
    ]
  : []
const files = readdirSync('test').filter(file => file.endsWith('.test.mjs')).sort().map(file => `test/${file}`)
const result = spawnSync(process.execPath, ['--test', ...coverage, ...files], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1

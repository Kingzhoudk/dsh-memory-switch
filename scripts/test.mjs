#!/usr/bin/env node
/**
 * Real-host integration runner for dsh-memory-switch.
 *
 * `tests/host-integration.mts` imports real Harness internals (`@deepseek-ai/dsh-*`)
 * and the agent-loop mock adapter, so it must run with a DSH source checkout on
 * the module-resolution path. This runner copies it into a temporary directory
 * INSIDE that checkout (so Node walks up to the checkout's `node_modules`), runs
 * it with `tsx`, and removes the directory afterwards.
 *
 * Usage:
 *   node scripts/test.mjs
 *   npm test                                   # unit + client + this script
 *   DSH_CHECKOUT=/path/to/checkout node scripts/test.mjs
 *
 * Environment:
 *   DSH_CHECKOUT                DSH source checkout (required to run)
 *   DSH_MEMORY_SWITCH_PLUGIN    plugin directory the test loads (default: this package)
 *
 * Without DSH_CHECKOUT this script reports a skip and exits 0, matching the
 * browser-half suite, which also skips when React cannot be resolved.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)))
const checkout = process.env.DSH_CHECKOUT
const tests = ['host-integration.mts']

/** Print a failure and exit non-zero. */
function fail(message) {
  console.error(`memory-switch-test: ${message}`)
  process.exit(1)
}

if (checkout === undefined || !existsSync(join(checkout, 'package.json'))) {
  console.log('memory-switch-test: skipped (set DSH_CHECKOUT to a deepseek-harness source checkout)')
  process.exit(0)
}
if (!existsSync(join(checkout, 'node_modules', 'tsx'))) {
  fail(`the checkout at "${checkout}" is missing tsx — run its package manager install first`)
}
for (const file of tests) {
  if (!existsSync(join(pluginDir, 'tests', file))) fail(`missing test script tests/${file}`)
}

const scratch = mkdtempSync(join(checkout, '.memory-switch-test-'))
const env = {
  ...process.env,
  DSH_CHECKOUT: checkout,
  DSH_MEMORY_SWITCH_PLUGIN: pluginDir,
}
let failed = 0
try {
  for (const file of tests) copyFileSync(join(pluginDir, 'tests', file), join(scratch, file))
  for (const file of tests) {
    console.log(`memory-switch-test: ${file}`)
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', join(scratch, file)], {
      cwd: checkout,
      env,
      stdio: 'inherit',
    })
    if (result.error !== undefined) fail(`could not start ${file}: ${result.error.message}`)
    if (result.status !== 0) {
      failed += 1
      console.error(`memory-switch-test: ${file} failed with status ${String(result.status)}`)
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (failed > 0) process.exit(1)
console.log(`memory-switch-test: all ${tests.length} script(s) passed`)

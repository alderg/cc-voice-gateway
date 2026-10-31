// A reporter for node --test that shows the run as one line in a terminal,
// written over after each test: how far it is, and how many passed, failed
// and were skipped. scripts/check-macos.sh uses it when its output is a
// terminal:
//
//   node --test --test-reporter=./scripts/test-progress.mjs --test-reporter-destination=stdout test/*.test.mjs
//
//          42%  150 of 355 tests, 149 passed, 1 failed
//
// It counts the top-level tests; a file that cannot run is one failed test,
// as node --test reports it. How many there are: the lines that start with
// test( in the files node --test was given; when the run ends, what ran.
// The last line stays, and the failed tests follow it, one line each.

import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

const INDENT = '      ' // under the text of check-macos.sh's PASS, WARN and INFO lines

function counted() {
  let total = 0
  for (const arg of process.argv.slice(1)) {
    try {
      total += readFileSync(arg, 'utf8').match(/^test\(/gm)?.length ?? 0
    } catch {
      // not a file: a pattern that node --test resolves itself
    }
  }
  return total
}

export default async function* progress(source) {
  let total = counted() // 0: not known
  let passed = 0
  let failed = 0
  let skipped = 0
  const failures = []
  const line = () => {
    const done = passed + failed + skipped
    let text = `${done} tests, ${passed} passed, ${failed} failed`
    if (total) {
      total = Math.max(total, done)
      text = `${String(Math.floor((done * 100) / total)).padStart(3)}%  ${done} of ${total} tests, ${passed} passed, ${failed} failed`
    }
    if (skipped) text += `, ${skipped} skipped`
    text = INDENT + text
    // Never wider than the terminal: a line that wraps is not written over.
    const columns = process.stdout.columns
    if (columns > 1) text = text.slice(0, columns - 1)
    return `\r\x1b[K${text}`
  }
  yield line()
  for await (const { type, data } of source) {
    if ((type !== 'test:pass' && type !== 'test:fail') || data.nesting !== 0) continue
    if (data.skip !== undefined || data.todo !== undefined) {
      skipped++
    } else if (type === 'test:pass') {
      passed++
    } else {
      failed++
      const file = data.file ? relative(process.cwd(), data.file) : ''
      const name = data.name === data.file ? file : data.name // a file that could not run, by its path (absolute on Node 20)
      const where = file && file !== name ? ` (${file}${data.line ? `:${data.line}` : ''})` : ''
      failures.push(`${INDENT}failed: ${name}${where}`)
    }
    yield line()
  }
  total = passed + failed + skipped
  yield `${line()}\n`
  if (failures.length) yield `${failures.join('\n')}\n`
}

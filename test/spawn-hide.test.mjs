// Every process this plugin starts must be invisible on Windows: no console
// window may flash when the host, or a lab script, spawns a child. `windowsHide`
// is the switch that does it, so this test statically checks every
// spawn / spawnSync / spawnImpl call site under lib/ and tools/.
//
// User requirement, 2026-10-14: 「你写的所有后台脚本都不要弹黑框，直接静默运行」
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** One entry per source file under lib/ or tools/, split into lines. */
function sources() {
  const out = []
  for (const [dir, suffix] of [['lib', '.js'], ['tools', '.mjs']]) {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (!name.endsWith(suffix)) continue
      const text = readFileSync(join(ROOT, dir, name), 'utf8')
      out.push({ file: `${dir}/${name}`, lines: text.split('\n') })
    }
  }
  return out
}

/** A call site, not an import and not a sentence in a comment. */
const CALL = /(?:^|[^\w.$])(spawn|spawnSync|spawnImpl)\s*\(/
/** How far past the call we look for the options object. */
const LOOKAHEAD = 25

test('every spawn call site hides the console window', () => {
  const offenders = []
  for (const { file, lines } of sources()) {
    lines.forEach((line, index) => {
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
      if (trimmed.startsWith('import ') || trimmed.startsWith('} from')) return
      if (!CALL.test(line)) return
      const window = lines.slice(index, index + LOOKAHEAD).join('\n')
      if (!/windowsHide:\s*true/.test(window)) offenders.push(`${file}:${index + 1}`)
    })
  }
  assert.deepEqual(
    offenders,
    [],
    `these spawn call sites do not pass windowsHide: true, so a console window would flash:\n${offenders.join('\n')}`,
  )
})

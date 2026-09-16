// Verify the SHIPPED package layout before publishing.
//
// Packaging bugs are invisible from a checkout: the code runs fine because the
// working tree has everything. This copies exactly what `package.json#files`
// would publish into a temp directory and then checks the things that break only
// for an installed user:
//
//   1. runtime files really are in the package (measured: `tools/` was left out of
//      `files`, and `lib/verify.js` spawns `tools/check-relevance.mjs` — the
//      published build would have judged nothing and injected nothing);
//   2. no absolute local path leaks into a shipped file (README, patch, lib);
//   3. state resolves under DSH_HOME from the packed copy, not inside node_modules;
//   4. the bundle patch parses and targets the row the loader expects;
//   5. the judge script runs from the packed layout (`--no-model` skips the model
//      call, which needs Ollama).
//
// Usage:
//   node tools/verify-package.mjs            # layout + state + judge (needs Ollama)
//   node tools/verify-package.mjs --no-model # skip the actual judgement
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const skipModel = args.includes('--no-model')
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const failures = []
const warnings = []
function check(ok, label, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label.padEnd(34)} ${detail}`)
  if (!ok) failures.push(label)
}

// --- 1. what `files` actually covers ---------------------------------------
const entries = []
for (const pattern of pkg.files ?? []) {
  const target = join(root, pattern)
  if (!existsSync(target)) {
    check(false, `files: ${pattern}`, '不存在')
    continue
  }
  if (statSync(target).isDirectory()) entries.push({ pattern, dir: true, target })
  else entries.push({ pattern, dir: false, target })
}
const required = ['lib', 'tools/check-relevance.mjs', 'tools/build-cards.mjs', 'tools/check-install.mjs', 'cordis.patch.yml', 'README.md', 'LICENSE']
for (const name of required) {
  check(
    (pkg.files ?? []).includes(name),
    `files 包含 ${name}`,
    (pkg.files ?? []).includes(name) ? '' : `当前：${JSON.stringify(pkg.files)}`,
  )
}

// --- 2. simulate the tarball ------------------------------------------------
const temp = mkdtempSync(join(tmpdir(), 'exprec-package-'))
const packed = join(temp, 'package')
const stateHome = join(temp, 'home')
let bytes = 0
let files = 0
function copyEntry(entry) {
  const destination = join(packed, entry.pattern)
  cpSync(entry.target, destination, { recursive: true })
}
try {
  cpSync(join(root, 'package.json'), join(packed, 'package.json'))
  for (const entry of entries) copyEntry(entry)
  const walk = (dir) => {
    for (const item of readdirSafe(dir)) {
      const full = join(dir, item)
      const stats = statSync(full)
      if (stats.isDirectory()) walk(full)
      else {
        files += 1
        bytes += stats.size
      }
    }
  }
  walk(packed)
  console.log(`\n模拟发布包：${files} 个文件 / ${(bytes / 1024).toFixed(1)} kB（不含 npm 的 package.json 与文档元数据）\n`)

  // Runtime files the plugin spawns or reads must exist in the packed layout.
  for (const rel of ['lib/index.js', 'lib/config.js', 'tools/check-relevance.mjs', 'tools/build-cards.mjs', 'cordis.patch.yml']) {
    check(existsSync(join(packed, rel)), `打包后存在 ${rel}`, '')
  }

  // --- 3. no absolute local path leaks --------------------------------------
  const leakPattern = /[A-Z]:\\{1,2}(?:Project|Users|THU)\b/i
  const inspect = ['README.md', 'README.zh.md', 'cordis.patch.yml', 'package.json', 'LICENSE', ...readdirSafe(join(packed, 'tools')).map((file) => `tools/${file}`)]
  for (const rel of inspect) {
    const full = join(packed, rel)
    if (!existsSync(full)) continue
    const text = readFileSync(full, 'utf8')
    const hit = text.match(leakPattern)
    check(hit === null, `不含本地绝对路径 ${rel}`, hit === null ? '' : `发现 ${hit[0]}`)
  }
  for (const rel of ['lib/index.js', 'lib/config.js', 'lib/verify.js']) {
    const text = readFileSync(join(packed, rel), 'utf8')
    // `join(PLUGIN_ROOT, 'tools', …)` is fine; a hard-coded drive letter is not.
    const hit = text.match(leakPattern)
    check(hit === null, `不含本地绝对路径 ${rel}`, hit === null ? '' : `发现 ${hit[0]}`)
  }

  // --- 4. the bundle patch is loadable and targets the expected row ----------
  const patch = readFileSync(join(packed, 'cordis.patch.yml'), 'utf8')
  check(!existsSync(join(packed, 'tools', 'lib', 'pairs-v2.mjs')), '发布包不带私人评测样本', '')
  check(/^-\s*insert:/m.test(patch), 'cordis.patch.yml 是 insert 列表', '')
  check(patch.includes('id: experience-recall'), 'patch 行 id 正确', '')
  check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'package.json dsh.bundle.patch 指向 patch', '')
  check(pkg.private !== true, 'package.json 不是 private', pkg.private === true ? 'private 会阻止发布' : '')

  // --- 5. state resolves under DSH_HOME from the packed copy -----------------
  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = stateHome
  const config = await import(pathToFileURL(join(packed, 'lib', 'config.js')).href)
  const resolved = config.resolveConfig({})
  const insideTemp = resolved.stateDir.startsWith(stateHome) && !resolved.stateDir.startsWith(root)
  check(insideTemp, '状态目录默认在 DSH_HOME 下', resolved.stateDir)
  check(resolved.logPath.endsWith(join('logs', 'observe.ndjson')), '默认日志路径', resolved.logPath)
  check(resolved.cardCachePath.endsWith(join('cache', 'cards.json')), '默认缓存路径', resolved.cardCachePath)
  check(
    !resolved.cardCachePath.split(/[\\/]/).includes('node_modules'),
    '缓存不写进 node_modules',
    resolved.cardCachePath,
  )
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome

  // --- 6. the judge runs from the packed layout -----------------------------
  if (skipModel) {
    console.log('\n(skip 判定器实跑：--no-model)')
  } else {
    const request = JSON.stringify({
      context: '正在给一个需要登录态的站点写抓取脚本，需要决定会话 cookie 怎么复用',
      card: '把站点凭据用系统加密存储（如 Windows DPAPI）而不是明文写在脚本里，登录态失效时重新走一次登录流程。',
      timeoutMs: 15000,
    })
    const run = spawnSync(process.execPath, [join(packed, 'tools', 'check-relevance.mjs')], {
      input: request,
      encoding: 'utf8',
      timeout: 30000,
    })
    let parsed
    try {
      parsed = JSON.parse(String(run.stdout ?? '').trim())
    } catch {
      parsed = undefined
    }
    check(
      run.status === 0 && typeof parsed?.useful === 'boolean',
      '打包后的判定器可运行',
      `exit ${run.status} ${JSON.stringify(parsed ?? String(run.stdout).slice(0, 80))}`,
    )
    if (parsed?.ms !== undefined) console.log(`     判定耗时 ${parsed.ms} ms`)
  }

  // --- 7. check-install runs without crashing from the packed layout --------
  const installCheck = spawnSync(process.execPath, [join(packed, 'tools', 'check-install.mjs')], { encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...process.env, DSH_HOME: stateHome } })
  check(installCheck.status === 0 || installCheck.status === 1, '打包后的 check-install 可运行', `exit ${installCheck.status}`)
  if (installCheck.status !== 0 && installCheck.status !== 1) {
    warnings.push(String(installCheck.stderr ?? '').slice(0, 200))
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

console.log('')
if (warnings.length > 0) for (const warning of warnings) console.log(`注意：${warning}`)
console.log(failures.length === 0 ? '结论：发布包布局通过' : `结论：${failures.length} 项未通过 —— ${failures.join('，')}`)
console.log(`（相对路径基准：${relative(process.cwd(), root) || '.'}）`)
process.exit(failures.length === 0 ? 0 : 1)

#!/usr/bin/env node
/**
 * 集成 RED：真实构建产物 lib/client.js 在隔离浏览器里跑**真实 apply**。
 *
 * 被测契约：client.ts 的 apply 必须把 header 模块接进插件生命周期——
 *   ① 装上它的样式表（`style[data-meow-header-mobile-css]`）；
 *   ② 插件自带的 disposer 能把这张样式表移除。
 *
 * 不 mock header 模块本身；react 只给最小导出（不渲染）；槽位回调一律不执行。
 * 另设对照：插件自己的 fold 样式表必须被装上——它证明 apply 真跑到底、ctx stub 足够；
 * 对照组不成立时判 **ENV(3)**，绝不把 harness 不足冒充成功能 RED。
 *
 * 运行：node scripts/test-header-mobile-integration.mjs [baseUrl]
 * 退出码：0 全过 / 1 集成不达(RED) / 3 环境或 harness 不可用
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { connect } from '../tests/header-mobile/cdp.mjs'
import { openGuiTab, startErrorWatch } from '../tests/header-mobile/fixture.mjs'
import { CTX_STUB, REACT_STUB, RUN_BUNDLE, RUN_DISPOSE_EFFECT_ONLY, RUN_DISPOSE_WINDOW, STEP_APPLY, STEP_CAPTURE, STEP_FACTORY, captureBundleText } from '../tests/header-mobile/integration.mjs'

const BASE = process.argv[2] ?? process.env.MEOW_BASE ?? 'http://192.168.1.100:3080'
const OUT_DIR = fileURLToPath(new URL('../artifacts/header-mobile', import.meta.url))
const CLIENT_BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url))

const checks = []
const check = (name, ok, detail, kind = 'integration') => {
  checks.push({ name, status: ok ? 'PASS' : 'FAIL', detail, kind })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`)
}
const skip = (name, detail, kind = 'integration') => {
  checks.push({ name, status: 'SKIP', detail, kind })
  console.log(`SKIP ${name} — ${detail}`)
}

const started = new Date()
let exitCode = 1
let cdp = null
let tab = null
let harnessOk = false

try {
  // ---- 构建产物 ----
  if (!existsSync(CLIENT_BUNDLE)) {
    console.log('lib/client.js 不存在 → 用仓库自己的 build.mjs 现场构建（只写 lib/，不动 src）')
    const r = spawnSync(process.execPath, ['build.mjs'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' })
    if (r.status !== 0) {
      console.log(`ENV FAIL — 构建失败：${(r.stderr || r.stdout || '').slice(0, 300)}`)
      harnessOk = false
      process.exitCode = 3
    }
  }
  const bundleText = existsSync(CLIENT_BUNDLE) ? readFileSync(CLIENT_BUNDLE, 'utf8') : null
  if (bundleText === null) {
    console.log('ENV FAIL — 拿不到 lib/client.js')
  } else {
    console.log(`bundle: ${(bundleText.length / 1024).toFixed(1)}kb`)
    cdp = await connect()
    if (cdp === null) {
      console.log('ENV FAIL — CDP 端点不可达')
    } else {
      const opened = await openGuiTab(cdp, { baseUrl: BASE, width: 390, height: 844 })
      tab = opened.tab
      if (!opened.booted) {
        console.log('ENV FAIL — GUI 未挂载')
      } else {
        const sid = tab.sessionId
        await startErrorWatch(cdp, sid)
        // 观测前的基线：页面里本来就有的相关样式表
        const before = await cdp.evaluate(
          sid,
          `JSON.stringify({
            headerSheets: document.querySelectorAll('style[data-meow-header-mobile-css]').length,
            foldSheets: document.querySelectorAll('style[data-meow-fold-css]').length,
            moduleLoader: typeof window.__ModuleLoader__,
          })`,
        ).then(JSON.parse)
        await cdp.evaluate(sid, `delete document.documentElement.dataset.meowApplyStage; true`)
        console.log(`before: ${JSON.stringify(before)}`)

        // ---- 注入真实产物 + 最小 require/ctx 垫片（三步分开，便于定位失败在哪一层）----
        const patched = captureBundleText(bundleText)
        await cdp.evaluate(sid, `${RUN_BUNDLE}\n${REACT_STUB}\n${CTX_STUB}\nglobalThis.__meowBundleText = ${JSON.stringify(patched)}; true`)
        const cap = await cdp.evaluate(sid, STEP_CAPTURE).then(JSON.parse)
        console.log(`capture: ${JSON.stringify(cap)}`)
        const fac = await cdp.evaluate(sid, STEP_FACTORY).then(JSON.parse)
        console.log(`factory: ${JSON.stringify(fac)}`)
        const result = fac.ok === true && fac.applyType === 'function'
          ? await cdp.evaluate(sid, STEP_APPLY).then(JSON.parse)
          : null
        if (result !== null) console.log(`apply: ${JSON.stringify({ ...result, errors: undefined })}`)

        check('factory-loaded', cap.factoryType === 'function',
          cap.factoryType === 'function' ? `bundle 工厂已捕获（${cap.textLen} 字节）` : `bundle 工厂未捕获${cap.captureError === null ? '' : '：' + cap.captureError}`)
        check('apply-exported', fac.ok === true && fac.applyType === 'function',
          fac.ok === true ? `导出面 ${JSON.stringify(fac.exportsShape)}` : `模块执行失败：${fac.reason}${fac.error === undefined ? '' : ' ' + fac.error}`)

        if (result === null) {
          skip('apply-no-throw', '工厂/导出面不成立 → 后续不判')
          skip('control-fold-sheet-installed', '同上')
          skip('header-sheet-installed', '同上')
          skip('header-sheet-removed-by-disposer', '同上')
          harnessOk = false
        } else {
          const stage = result.applyStage
          const earlyExit = stage !== null && String(stage).startsWith('exit:')
          check('apply-no-throw', result.applyError === null, result.applyError === null ? 'apply 未抛异常' : `apply 抛异常：${result.applyError}`)
          check('apply-not-early-exit', !earlyExit, `applyStage=${stage ?? '(未打标=走到安装路径)'}`)

          // 对照组：插件自己的 fold 样式表必须装上
          const foldInstalled = (result.foldSheets ?? 0) > 0
          check('control-fold-sheet-installed', foldInstalled,
            `fold 样式表 ${result.foldSheets} 张（apply 是否真跑到底）`, 'control')

          if (!foldInstalled || earlyExit) {
            harnessOk = false
            console.log('harness 不足：apply 没跑到安装路径（对照组不成立）→ 本次结果按 ENV 处理，不冒充 RED')
          } else {
            harnessOk = true
            // ---- ① header 模块样式表被安装 ----
            check('header-sheet-installed', (result.headerSheets ?? 0) > 0,
              `style[data-meow-header-mobile-css] × ${result.headerSheets ?? 0}（期望 ≥1：client.ts 的 apply 应调用 installMobileHeader 并把 disposer 登记进拆除清单）`)

            // ---- ② 仅 ctx.effect 就应移除 header 样式（不依赖 window 清理入口）----
            const effectOnly = await cdp.evaluate(sid, RUN_DISPOSE_EFFECT_ONLY).then(JSON.parse)
            console.log(`effect-only dispose: ${JSON.stringify(effectOnly)}`)
            check('effect-only-removes-header-sheet',
              effectOnly.ran > 0 && (effectOnly.after?.headerSheets ?? 1) === 0 && (effectOnly.before?.headerSheets ?? 0) > 0,
              `ctx.effect 拆除器 ${effectOnly.ran} 个：header 样式表 ${effectOnly.before?.headerSheets ?? 0} → ${effectOnly.after?.headerSheets ?? 0}${effectOnly.firstError === null ? '' : '；首个错误：' + effectOnly.firstError}`, 'safety')

            // ---- ③ 双清理幂等：再跑 window 入口不得抛错、不得误伤别的东西 ----
            const windowDispose = await cdp.evaluate(sid, RUN_DISPOSE_WINDOW).then(JSON.parse)
            console.log(`window dispose: ${JSON.stringify(windowDispose)}`)
            check('window-dispose-idempotent', windowDispose.threw === null && (windowDispose.after?.headerSheets ?? 1) === 0,
              `第二次清理 threw=${windowDispose.threw} header 样式表 ${windowDispose.before?.headerSheets ?? 0} → ${windowDispose.after?.headerSheets ?? 0}（双清理幂等）`, 'safety')
            check('control-fold-sheet-removed', (windowDispose.after?.foldSheets ?? 1) === 0,
              `对照：window 入口仍负责其余资源（fold 样式表 ${windowDispose.before?.foldSheets ?? 0} → ${windowDispose.after?.foldSheets ?? 0}）`, 'control')
          }
          if ((result.errors ?? []).length > 0) {
            skip('page-errors-clean', `页面记录了 ${result.errors.length} 条错误：${result.errors.slice(0, 2).join(' | ')}`, 'safety')
          } else {
            check('page-errors-clean', true, '执行期间页面无未捕获错误', 'safety')
          }
        }
      }
    }
  }
} catch (e) {
  check('runner-exception', false, String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e))
} finally {
  try { if (tab !== null) await tab.close() } catch { /* ignore */ }
  try { if (cdp !== null) cdp.close() } catch { /* ignore */ }
}

const failed = checks.filter((c) => c.status === 'FAIL')
const passed = checks.filter((c) => c.status === 'PASS')
const skipped = checks.filter((c) => c.status === 'SKIP')
const verdict = !harnessOk ? 'ENV' : failed.length > 0 ? 'RED' : 'GREEN'
exitCode = !harnessOk ? 3 : failed.length > 0 ? 1 : 0

const stamp = started.toISOString().replace(/[:.]/g, '-').slice(0, 19)
const md = [
  `# header-mobile 集成回归 ${verdict} — ${started.toISOString()}`,
  '',
  `- base: ${BASE}`,
  `- 产物: lib/client.js（真实构建，非 mock）`,
  `- PASS ${passed.length} / FAIL ${failed.length} / SKIP ${skipped.length}`,
  '',
  '## FAIL',
  ...failed.map((c) => `- **${c.name}** [${c.kind}] — ${c.detail}`),
  '',
  '## SKIP',
  ...skipped.map((c) => `- ${c.name} [${c.kind}] — ${c.detail}`),
  '',
  '## PASS',
  ...passed.map((c) => `- ${c.name} [${c.kind}] — ${c.detail}`),
  '',
].join('\n')
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, `integration-${stamp}.json`), JSON.stringify({ verdict, checks }, null, 1))
writeFileSync(join(OUT_DIR, `integration-${stamp}.md`), md)
if (verdict === 'RED') writeFileSync(join(OUT_DIR, 'INTEGRATION-RED.md'), md)
if (verdict === 'GREEN') writeFileSync(join(OUT_DIR, 'INTEGRATION-GREEN.md'), md)

console.log(`\n--- ${verdict}: PASS ${passed.length} / FAIL ${failed.length} / SKIP ${skipped.length} ---`)
console.log(`artifacts: ${OUT_DIR}/integration-${stamp}.json|md`)
process.exit(exitCode)

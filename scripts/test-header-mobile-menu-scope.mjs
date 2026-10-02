#!/usr/bin/env node
/**
 * 最小范围 RED：手机顶部规则的**作用域**不得外溢到"更多"菜单内部。
 *
 * 现象（Lead review）：`src/header-mobile.ts` 里针对 headerUtilities 的
 * `… button { min-height: 44px }` 会把**菜单项**（菜单渲染在 utilities 子树内）
 * 一起顶到 44px——超出"仅顶部"的范围。
 *
 * 本用例只判两件事：
 *   ① 打开"更多"菜单，**逐项**比较候选安装前后的高度必须相同（不是只比菜单容器）；
 *   ② 顶部 trigger（更多按钮 / 面板按钮）仍必须 ≥44px（这是被批准的行为，不能被这次收紧改坏）。
 *
 * 运行：node scripts/test-header-mobile-menu-scope.mjs [baseUrl]
 * 退出码：0 全过 / 1 行为不达(RED) / 3 环境不可用
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { connect, sleep } from '../tests/header-mobile/cdp.mjs'
import { measureAt, ensureNonEmptySession, openGuiTab, startErrorWatch, menuItemGeometry, closeMoreMenu, tapMoreButton } from '../tests/header-mobile/fixture.mjs'
import { install, dispose, prepareCandidate } from '../tests/header-mobile/candidate.mjs'

const BASE = process.argv[2] ?? process.env.MEOW_BASE ?? 'http://192.168.1.100:3080'
const OUT_DIR = fileURLToPath(new URL('../artifacts/header-mobile', import.meta.url))
const TOUCH_MIN_H = 44

const checks = []
const raw = {}
const check = (name, ok, detail, kind = 'scope') => {
  checks.push({ name, status: ok ? 'PASS' : 'FAIL', detail, kind })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`)
}
const skip = (name, detail, kind = 'scope') => {
  checks.push({ name, status: 'SKIP', detail, kind })
  console.log(`SKIP ${name} — ${detail}`)
}
const px = (v) => (typeof v === 'number' ? v.toFixed(1) : String(v))

const started = new Date()
let cdp = null
let tab = null
let envFailed = false

/**
 * 打开菜单 → 逐项几何 → 关闭。
 *
 * 打开方式：先派发 **CDP Input 域可信点按**；若 700ms 内 `aria-expanded` 未翻转
 * （实测该按钮内部还嵌了一个图标按钮，可信点按会落在内层），则回退为页面内对
 * `aria-haspopup="menu"` 元素本身 click。用了哪种机制会记进产物，不冒充可信输入。
 */
async function openMenuAndMeasure(sid) {
  let mechanism = 'trusted-input'
  let tap = await tapMoreButton(cdp, sid)
  await sleep(700)
  let open = await menuOpen(sid)
  if (!open) {
    mechanism = 'page-click-fallback'
    await cdp.evaluate(sid, `(() => {
      const b = document.querySelector('[class*="_headerUtilities"] button[aria-haspopup="menu"]')
      if (b !== null) b.click()
      return b !== null
    })()`)
    await sleep(700)
    open = await menuOpen(sid)
  }
  const geo = await menuItemGeometry(cdp, sid)
  await closeMoreMenu(cdp, sid)
  await sleep(300)
  return { ...geo, mechanism, tap: tap, open }
}

/** 菜单是否真的开着（React 状态 + 真实菜单节点双证）。 */
async function menuOpen(sid) {
  return cdp.evaluate(
    sid,
    `(() => {
      const btn = document.querySelector('[class*="_headerUtilities"] button[aria-haspopup="menu"]')
      const menus = Array.from(document.querySelectorAll('[role="menu"]')).filter((m) => m.getBoundingClientRect().width > 0)
      return btn !== null && btn.getAttribute('aria-expanded') === 'true' && menus.length > 0
    })()`,
  )
}

try {
  cdp = await connect()
  if (cdp === null) {
    envFailed = true
    console.log('ENV FAIL — CDP 端点不可达')
  } else {
    const opened = await openGuiTab(cdp, { baseUrl: BASE, width: 390, height: 844 })
    tab = opened.tab
    if (!opened.booted) {
      envFailed = true
      console.log('ENV FAIL — GUI 未挂载')
    } else {
      const sid = tab.sessionId
      await startErrorWatch(cdp, sid)
      const session = await ensureNonEmptySession(cdp, sid)
      if (!session.ok) {
        envFailed = true
        console.log('ENV FAIL — 拿不到非空会话 header')
      } else {
        await measureAt(cdp, sid, { width: 390, height: 844 })

        // ---- 基线（候选未安装）----
        const baseMenu = await openMenuAndMeasure(sid)
        raw.baseline = baseMenu
        if (baseMenu.open !== true || baseMenu.items.length === 0) {
          envFailed = true
          console.log(`ENV FAIL — "更多"菜单打不开或没有菜单项（open=${baseMenu.open} mechanism=${baseMenu.mechanism}）`)
        } else {
          console.log(`baseline 菜单项（打开方式 ${baseMenu.mechanism}）：${baseMenu.items.map((i) => `${i.label}=${px(i.h)}px(minH ${i.minHeight})`).join(' | ')}`)

          // ---- 安装候选 ----
          const cand = await prepareCandidate(cdp, sid)
          console.log(`candidate: ${cand.status}${cand.detail === undefined ? '' : ' (' + cand.detail + ')'}`)
          if (cand.status !== 'loaded') {
            skip('candidate-loaded', `候选未加载（${cand.status}）→ 本次不判范围，避免假红`, 'scope')
            envFailed = true
          } else {
            const inst = await install(cdp, sid)
            check('install-ok', inst.ok === true, JSON.stringify(inst), 'scope')

            // ---- 安装后测 trigger 与菜单项 ----
            const g = await measureAt(cdp, sid, { width: 390, height: 844 })
            const afterMenu = await openMenuAndMeasure(sid)
            raw.afterInstall = { trigger: g.moreBtn, panel: g.panelBtn, menu: afterMenu }

            console.log(`after 菜单项（打开方式 ${afterMenu.mechanism}）：${afterMenu.items.map((i) => `${i.label}=${px(i.h)}px(minH ${i.minHeight})`).join(' | ')}`)
            console.log(`after 容器：${JSON.stringify(afterMenu.container)}（基线 ${JSON.stringify(baseMenu.container)}）`)

            // 门禁：比的是同一批项
            const sameLabels = baseMenu.items.length === afterMenu.items.length
              && baseMenu.items.every((it, i) => (afterMenu.items[i]?.label ?? '') === it.label)
            check('menu-open-both-arms', baseMenu.open === true && afterMenu.open === true,
              `开菜单：基线 ${baseMenu.open}(${baseMenu.mechanism}) / 安装后 ${afterMenu.open}(${afterMenu.mechanism})`, 'scope')
            check('menu-same-items', sameLabels && afterMenu.open === true,
              `基线 ${baseMenu.items.length} 项 / 安装后 ${afterMenu.items.length} 项，标签一致=${sameLabels}`, 'scope')

            // ① 逐项高度必须相同（±0.5px）
            const diffs = []
            for (let i = 0; i < Math.min(baseMenu.items.length, afterMenu.items.length); i++) {
              const a = baseMenu.items[i]; const b = afterMenu.items[i]
              if (Math.abs(a.h - b.h) > 0.5) diffs.push(`${a.label}: ${px(a.h)}→${px(b.h)}`)
            }
            check('menu-item-height-unchanged', diffs.length === 0 && afterMenu.items.length > 0,
              diffs.length === 0
                ? `${afterMenu.items.length} 个菜单项高度与安装前一致（${afterMenu.items.map((i) => px(i.h)).join('/')}）`
                : `菜单项被顶栏规则误伤：${diffs.join('; ')}（minHeight ${afterMenu.items.map((i) => i.minHeight).join('/')}）`, 'scope')

            // 容器高度一并记录（不替代逐项判据）
            const cA = baseMenu.container?.h; const cB = afterMenu.container?.h
            check('menu-container-height-unchanged', cA !== undefined && cB !== undefined && Math.abs(cA - cB) <= 0.5,
              `菜单容器 ${px(cA)} → ${px(cB)}（附证；主判据是逐项）`, 'scope')

            // ② 顶部 trigger 仍 ≥44
            check('trigger-more-height-44', g.moreBtn !== null && g.moreBtn.h >= TOUCH_MIN_H,
              `更多按钮 h=${px(g.moreBtn?.h)} 期望 ≥${TOUCH_MIN_H}`, 'scope')
            check('trigger-panel-height-44', g.panelBtn !== null && g.panelBtn.h >= TOUCH_MIN_H,
              `面板按钮 h=${px(g.panelBtn?.h)} 期望 ≥${TOUCH_MIN_H}`, 'scope')

            raw.dispose = await dispose(cdp, sid)
          }
        }
      }
    }
  }
} catch (e) {
  check('runner-exception', false, String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e), 'scope')
} finally {
  try { if (tab !== null) await tab.close() } catch { /* ignore */ }
  try { if (cdp !== null) cdp.close() } catch { /* ignore */ }
}

const failed = checks.filter((c) => c.status === 'FAIL')
const passed = checks.filter((c) => c.status === 'PASS')
const skipped = checks.filter((c) => c.status === 'SKIP')
const verdict = envFailed && failed.length === 0 ? 'ENV' : failed.length > 0 ? 'RED' : 'GREEN'
const exitCode = verdict === 'ENV' ? 3 : failed.length > 0 ? 1 : 0

const stamp = started.toISOString().replace(/[:.]/g, '-').slice(0, 19)
const md = [
  `# header-mobile 菜单作用域 ${verdict} — ${started.toISOString()}`,
  '',
  `- base: ${BASE}`,
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
writeFileSync(join(OUT_DIR, `menu-scope-${stamp}.json`), JSON.stringify({ verdict, checks, raw }, null, 1))
writeFileSync(join(OUT_DIR, `menu-scope-${stamp}.md`), md)
if (verdict === 'RED') writeFileSync(join(OUT_DIR, 'MENU-SCOPE-RED.md'), md)
if (verdict === 'GREEN') writeFileSync(join(OUT_DIR, 'MENU-SCOPE-GREEN.md'), md)

console.log(`\n--- ${verdict}: PASS ${passed.length} / FAIL ${failed.length} / SKIP ${skipped.length} ---`)
console.log(`artifacts: ${OUT_DIR}/menu-scope-${stamp}.json|md`)
process.exit(exitCode)

#!/usr/bin/env node
/**
 * 手机端顶部（header）适配回归 —— 真实浏览器几何测试。
 *
 * 被测行为（Lead 批准口径）：
 *   ① <768：标题 / 更多 / 面板 **必在首行**；
 *   ② <768：附加项（团队 / 预设 / 后台任务 / 子代理目录）**标签完整可读**，
 *      允许自然换到后续行；
 *   ③ <768：tabs **独占最后一行**；
 *   ④ <768：主要按钮高 ≥44px；
 *   ⑤ ≥768：与**当前运行基线**逐项一致（未安装候选 vs 安装候选 A/B，同标签同字体）；
 *   ⑥ 卸载：新模块自己的 disposer 调用后几何/属性回落到基线。
 *
 * 判据一律走真实排版结果（getBoundingClientRect / elementFromPoint / scrollWidth），
 * 不做 CSS 文本匹配；超长标签**允许 ellipsis**，因此不以 `scrollW > clientW` 判失败，
 * 只判"不越界 + 文字非隐藏"。
 *
 * 运行：node scripts/test-header-mobile-wrap.mjs [baseUrl]
 *   baseUrl 默认 http://192.168.1.100:3080（浏览器所在宿主的可达地址）
 *   MEOW_CDP 覆盖 CDP 端点（默认 http://127.0.0.1:9222）
 * 退出码：0 全过 / 1 行为不达(RED) / 3 环境不可用 / 4 锚点漂移
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { connect, sleep } from '../tests/header-mobile/cdp.mjs'
import { measureAt, ensureNonEmptySession, openGuiTab, currentTitle, measureWithFurl, measureWithLongTitle, menuGeometry, closeMoreMenu, startErrorWatch, readErrors, measureWithLongLabels, measureAfterEntryRemoved, tapMoreButton, tapFab, fabState, sidebarExpanded, detachSessionSlot, reattachSessionSlot } from '../tests/header-mobile/fixture.mjs'
import { install, dispose, prepareCandidate } from '../tests/header-mobile/candidate.mjs'
import { sameRow } from '../tests/header-mobile/geometry.mjs'

const BASE = process.argv[2] ?? process.env.MEOW_BASE ?? 'http://192.168.1.100:3080'
const OUT_DIR = fileURLToPath(new URL('../artifacts/header-mobile', import.meta.url))
const NARROW = [320, 360, 390, 430, 767]
const WIDE = [768, 1024, 1440]
const TOUCH_MIN_H = 44

const checks = []
const raw = {}
/**
 * kind 语义（区分"fixture 布局"与"真实 GUI 交互"，防止把无交互的布局断言当 E2E）：
 *  - layout      ：真实 GUI DOM + 真实排版引擎下的几何断言，不含任何用户操作
 *  - interaction ：经 CDP Input 域派发**可信**输入之后的断言（真实点按）
 *  - safety      ：容错/清理断言（不得报错、不得留残渣）
 */
function check(name, ok, detail, kind = 'layout') {
  checks.push({ name, status: ok ? 'PASS' : 'FAIL', detail, kind })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`)
}
function skip(name, detail, kind = 'layout') {
  checks.push({ name, status: 'SKIP', detail, kind })
  console.log(`SKIP ${name} — ${detail}`)
}
const fail = (name, detail) => check(name, false, detail)
const near = (a, b, tol = 1) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol
const px = (v) => (typeof v === 'number' ? v.toFixed(1) : String(v))

function visibleItems(g) {
  const items = []
  const push = (name, b) => { if (b !== null && b !== undefined && b.display !== 'none' && b.w > 0.5 && b.h > 0.5) items.push({ name, box: b }) }
  push('title', g.row1.title)
  push('crumbs', g.row1.crumbs)
  push('utilities', g.row1.utilities)
  push('corner', g.row1.corner)
  for (const e of g.entries) push(`entry:${e.kind}`, e.box)
  return items
}

function simplify(g) {
  return {
    header: g.header === null ? null : { h: g.header.h, y: g.header.y, w: g.header.w },
    titleRow: g.titleRow === null ? null : { h: g.titleRow.h, y: g.titleRow.y, w: g.titleRow.w },
    row1: Object.fromEntries(Object.entries(g.row1).map(([k, v]) => [k, v === null ? null : { y: v.y, h: v.h, w: v.w }])),
    tabs: g.tabs === null ? null : { y: g.tabs.y, h: g.tabs.h, w: g.tabs.w },
    entries: g.entries.map((e) => ({ kind: e.kind, y: e.box === null ? null : e.box.y, w: e.box === null ? null : e.box.w, h: e.box === null ? null : e.box.h })),
    attrs: g.attrs,
    sheets: g.sheets,
  }
}

/** 布局完整性（不含"标签可读/触控尺寸"这两项特性判据）：行锁死、tabs 末行、无重叠、不越界、无横向溢出。 */
function assertLayoutIntegrity(label, g, kind = 'layout') {
  const r1 = g.row1
  check(`row1-locked(${label})`, sameRow(r1.crumbs, r1.utilities) && sameRow(r1.crumbs, r1.corner),
    `crumbs.y=${px(r1.crumbs?.y)} utilities.y=${px(r1.utilities?.y)} corner.y=${px(r1.corner?.y)}`, kind)
  const items = visibleItems(g)
  const others = items.filter((i) => i.name !== 'tabs')
  const maxBottom = others.length === 0 ? 0 : Math.max(...others.map((i) => i.box.bottom))
  if (g.tabs !== null && g.tabs.display !== 'none' && g.tabs.h > 0.5) {
    check(`tabs-last(${label})`, g.tabs.y >= maxBottom - 2, `tabs.y=${px(g.tabs?.y)} 其余最大 bottom=${px(maxBottom)}`, kind)
  } else {
    skip(`tabs-last(${label})`, '本态没有可见 tabs（空态会话不渲染 tablist）', kind)
  }
  // title 是 crumbs 的子节点，天然相交，剔除
  const overlapSet = others.filter((i) => i.name !== 'title')
  let overlapHit = null
  for (let i = 0; i < overlapSet.length && overlapHit === null; i++) {
    for (let j = i + 1; j < overlapSet.length; j++) {
      const a = overlapSet[i].box; const b = overlapSet[j].box
      if (a.x + 1 < b.right && b.x + 1 < a.right && a.y + 1 < b.bottom && b.y + 1 < a.bottom) {
        overlapHit = `${overlapSet[i].name}×${overlapSet[j].name}`
        break
      }
    }
  }
  check(`no-overlap(${label})`, overlapHit === null, overlapHit === null ? `${overlapSet.length} 个可见项两两不相交` : `重叠：${overlapHit}`, kind)
  const outOfBox = items.filter((i) => i.box.x < (g.header?.x ?? 0) - 1 || i.box.right > (g.header?.right ?? 1e9) + 1)
  check(`inside-header(${label})`, outOfBox.length === 0,
    outOfBox.length === 0 ? `${items.length} 个可见项都在 header 内` : `越界：${outOfBox.map((i) => `${i.name}[${px(i.box.x)}..${px(i.box.right)}]`).join(',')} header=[${px(g.header?.x)}..${px(g.header?.right)}]`, kind)
  check(`no-doc-overflow(${label})`, g.doc.scrollW <= g.doc.clientW + 1, `doc.scrollW=${g.doc.scrollW} clientW=${g.doc.clientW}`, kind)
}

/** 窄屏（<768）全套断言。 */
function assertNarrow(width, g, natural) {
  const tag = `${width}px`
  raw[`narrow:${width}`] = g
  if (g.viewport.ok !== true) {
    check(`viewport(${tag})`, false, `视口覆盖未生效 innerW=${g.viewport.innerW} 期望 ${width}`)
    return false
  }
  assertLayoutIntegrity(tag, g)

  // ② 附加项标签完整可读（按各自隐藏来源分开判；隐藏项同样要判失败，不能静默跳过）
  const KNOWN = ['team', 'preset', 'jobs', 'subagent']
  const kinds = g.entries.map((e) => e.kind)
  const missing = KNOWN.filter((k) => !kinds.includes(k))
  check(`entries-classified(${tag})`, missing.length === 0,
    missing.length === 0 ? `附加项齐备：${kinds.join('/')}` : `识别不到：${missing.join(',')}（实测 ${kinds.join('/') || '无'}）`)
  for (const e of g.entries) {
    if (e.kind === 'other') continue // 已在 entries-classified 判失败
    const entryShown = e.box !== null && e.box.display !== 'none'
    const labelShown = entryShown && e.label !== null && e.label.display !== 'none' && e.label.w > 0.5
    const textShown = e.label === null ? false : (e.label.text === '' || (e.label.scrollW > 0 && e.label.fontSize !== '0px'))
    const noDot = (e.btnDotContent === 'none' || e.btnDotContent === null) && (e.firstSpanDotContent === 'none' || e.firstSpanDotContent === null)
    check(`label-readable(${tag}:${e.kind})`, labelShown && textShown && noDot,
      `entry.display=${e.box?.display} label.display=${e.label?.display} label.w=${px(e.label?.w)} fontSize=${e.label?.fontSize} text="${e.label?.text ?? ''}" btn::before=${e.btnDotContent} firstSpan::before=${e.firstSpanDotContent}`)
    // 条目自然宽（不被压成图标）
    const nat = natural[e.kind]
    if (nat === undefined || nat < 30) skip(`entry-natural(${tag}:${e.kind})`, `对照自然宽不可得(${px(nat)})，跳过`)
    else check(`entry-natural(${tag}:${e.kind})`, e.box !== null && e.box.w >= 0.9 * nat, `w=${px(e.box?.w)} 期望 ≥${px(0.9 * nat)}（1440 对照 ${px(nat)}）`)
    // ④ 触控高度
    check(`touch-height(${tag}:${e.kind})`, e.btn !== null && e.btn.h >= TOUCH_MIN_H, `btn.h=${px(e.btn?.h)} 期望 ≥${TOUCH_MIN_H}`)
  }

  // 更多 / 面板 触控高度
  check(`touch-height(${tag}:more)`, g.moreBtn !== null && g.moreBtn.h >= TOUCH_MIN_H, `moreBtn.h=${px(g.moreBtn?.h)}`)
  check(`touch-height(${tag}:panel)`, g.panelBtn !== null && g.panelBtn.h >= TOUCH_MIN_H, `panelBtn.h=${px(g.panelBtn?.h)}`)
  return true
}

function compareGolden(label, before, after, kind = 'layout') {
  const tag = typeof label === 'number' ? `${label}px` : String(label)
  const diffs = []
  if (!near(before.header?.h, after.header?.h)) diffs.push(`header.h ${px(before.header?.h)}→${px(after.header?.h)}`)
  if (!near(before.titleRow?.h, after.titleRow?.h)) diffs.push(`titleRow.h ${px(before.titleRow?.h)}→${px(after.titleRow?.h)}`)
  for (const key of ['crumbs', 'utilities', 'corner', 'title']) {
    if (!near(before.row1[key]?.y, after.row1[key]?.y)) diffs.push(`${key}.y ${px(before.row1[key]?.y)}→${px(after.row1[key]?.y)}`)
    if (!near(before.row1[key]?.h, after.row1[key]?.h)) diffs.push(`${key}.h ${px(before.row1[key]?.h)}→${px(after.row1[key]?.h)}`)
  }
  if (!near(before.tabs?.y, after.tabs?.y)) diffs.push(`tabs.y ${px(before.tabs?.y)}→${px(after.tabs?.y)}`)
  for (const e of before.entries) {
    const a = after.entries.find((x) => x.kind === e.kind)
    if (a === undefined) continue
    if (!near(e.w, a.w)) diffs.push(`${e.kind}.w ${px(e.w)}→${px(a.w)}`)
    if (!near(e.h, a.h)) diffs.push(`${e.kind}.h ${px(e.h)}→${px(a.h)}`)
  }
  check(`golden-unchanged(${tag})`, diffs.length === 0, diffs.length === 0 ? '与未安装基线逐项一致(±1px)' : diffs.slice(0, 6).join('; '), kind)
}

const started = new Date()
let exitCode = 1
let tab = null
let cdp = null
let envFailed = false
let anchorDrift = false
let candidateStatus = 'unknown'

try {
  cdp = await connect()
  if (cdp === null) {
    envFailed = true
    console.log('ENV FAIL — CDP 端点不可达（本机无浏览器二进制，需外部 Chrome 的 127.0.0.1:9222）')
  } else {
    console.log(`env: browser=${cdp.browser} endpoint=${cdp.endpoint} base=${BASE}`)
    const opened = await openGuiTab(cdp, { baseUrl: BASE, width: 390, height: 844 })
    tab = opened.tab
    if (!opened.booted) {
      envFailed = true
      console.log('ENV FAIL — GUI 未挂载（登录墙？隔离上下文 cookie 复制失败？）')
    } else {
      console.log(`env: plugin-style-loaded=${opened.pluginUp}`)
      const sid = tab.sessionId
      const session = await ensureNonEmptySession(cdp, sid)
      raw.session = session
      if (!session.ok) {
        envFailed = true
        console.log(`ENV FAIL — 拿不到非空会话 header（侧栏行 ${session.rows} 个）`)
      } else {
        console.log(`env: session title="${(await currentTitle(cdp, sid)).slice(0, 40)}" clicked=${session.clicked}`)
        await startErrorWatch(cdp, sid) // 页面内真实报错/未处理拒绝全记下，安全用例据此判

        // ---- 锚点自检（drift ≠ 行为失败）----
        const probe = await measureAt(cdp, sid, { width: 390, height: 844 })
        if (probe.header === null || probe.titleRow === null || probe.row1.crumbs === null || probe.tabs === null) {
          anchorDrift = true
          console.log('ANCHOR DRIFT — 锚点命中缺失：' + JSON.stringify({
            header: probe.header !== null, titleRow: probe.titleRow !== null,
            crumbs: probe.row1.crumbs !== null, tabs: probe.tabs !== null,
            entries: probe.entries.length,
          }))
        } else {
          console.log(`anchors: entries=${probe.entries.map((e) => e.kind).join('/')} tabs=${probe.tabsCount}`)

          // ---- 候选模块 ----
          const cand = await prepareCandidate(cdp, sid)
          candidateStatus = cand.status
          console.log(`candidate: status=${cand.status}${cand.detail === undefined ? '' : ` (${cand.detail})`} bytes=${cand.bytes ?? 0}`)
          if (cand.status !== 'loaded') {
            console.log('candidate 降级为 noop —— 断言将以"行为不达"失败（RED），不是 import 错误')
          }

          // ---- 基线（未安装）----
          const base390 = await measureAt(cdp, sid, { width: 390, height: 844 })
          raw.base390 = base390
          const ctrl = await measureAt(cdp, sid, { width: 1440, height: 900, dsf: 1 })
          raw.control1440 = ctrl
          const natural = {}
          for (const e of ctrl.entries) {
            if (e.box === null) continue
            natural[e.kind] = Math.max(natural[e.kind] ?? 0, e.box.w)
          }
          console.log(`control@1440: natural=${JSON.stringify(natural)} header.h=${px(ctrl.header?.h)} tabs.y=${px(ctrl.tabs?.y)}`)
          const goldenBefore = {}
          for (const w of WIDE) goldenBefore[w] = simplify(await measureAt(cdp, sid, { width: w, height: 900, dsf: 1 }))

          // ---- 安装候选（缺失时是 noop）----
          const inst = await install(cdp, sid)
          raw.install = inst
          console.log(`install: ${JSON.stringify(inst)}`)
          if (cand.status === 'loaded') {
            check('install-returns-disposer', inst.ok === true && inst.returnedFunction === true,
              `installMobileHeader() 返回 disposer：${inst.returnedFunction === true}`)
          } else {
            skip('install-returns-disposer', `候选缺失（${cand.status}）→ noop，无法验证真实 disposer`)
          }

          // ---- 窄屏断言 ----
          for (const w of NARROW) {
            const g = await measureAt(cdp, sid, { width: w, height: 844 })
            assertNarrow(w, g, natural)
          }

          // ---- 长标题压测（390）----
          await measureAt(cdp, sid, { width: 390, height: 844 })
          const long = await measureWithLongTitle(cdp, sid)
          raw.longTitle390 = long
          check('long-title-row1-locked', sameRow(long.row1.crumbs, long.row1.utilities) && sameRow(long.row1.crumbs, long.row1.corner),
            `crumbs.y=${px(long.row1.crumbs?.y)} utilities.y=${px(long.row1.utilities?.y)} corner.y=${px(long.row1.corner?.y)}`)
          check('long-title-not-hidden', long.row1.title !== null && long.row1.title.display !== 'none' && long.row1.title.w > 0.5,
            `title.display=${long.row1.title?.display} w=${px(long.row1.title?.w)}（允许 ellipsis，不判 scrollW）`)
          check('long-title-no-overflow', long.doc.scrollW <= long.doc.clientW + 1, `doc.scrollW=${long.doc.scrollW} clientW=${long.doc.clientW}`)
          const longOut = visibleItems(long).filter((i) => i.box.right > (long.header?.right ?? 1e9) + 1)
          check('long-title-inside-header', longOut.length === 0, longOut.length === 0 ? '无越界项' : `越界：${longOut.map((i) => i.name).join(',')}`)

          // ---- furl 首行让位（390）----
          const furl = await measureWithFurl(cdp, sid)
          raw.furl390 = furl
          check('furl-row1-locked', sameRow(furl.row1.crumbs, furl.row1.utilities) && sameRow(furl.row1.crumbs, furl.row1.corner),
            `crumbs.y=${px(furl.row1.crumbs?.y)} utilities.y=${px(furl.row1.utilities?.y)} corner.y=${px(furl.row1.corner?.y)}`)
          check('furl-inside-header', visibleItems(furl).every((i) => i.box.x >= (furl.header?.x ?? 0) - 1 && i.box.right <= (furl.header?.right ?? 1e9) + 1),
            `header=[${px(furl.header?.x)}..${px(furl.header?.right)}]`)

          // ---- 菜单可见性（390，**真实点按**：CDP Input 域可信事件，不是页面内 el.click()）----
          await measureAt(cdp, sid, { width: 390, height: 844 })
          const tapMore = await tapMoreButton(cdp, sid)
          raw.menuTap = tapMore
          await sleep(700)
          const menu = await menuGeometry(cdp, sid)
          raw.menu390 = menu
          const insideViewport = menu.visible === true && menu.rect.x >= -1 && menu.rect.y >= -1 && menu.rect.right <= menu.vw + 1 && menu.rect.bottom <= menu.vh + 1
          check('menu-visible', menu.visible === true,
            (tapMore.tapped === true ? `可信点按(${px(tapMore.x)},${px(tapMore.y)}) 遮挡=${tapMore.occludedBy ?? '无'} → ` : '按钮不可点 → ')
            + (menu.visible === true ? `菜单 rect=[${px(menu.rect.x)},${px(menu.rect.y)},${px(menu.rect.w)}×${px(menu.rect.h)}]` : '未找到可见菜单'), 'interaction')
          check('menu-inside-viewport', insideViewport,
            menu.visible === true ? `rect.right=${px(menu.rect.right)} vw=${menu.vw} rect.bottom=${px(menu.rect.bottom)} vh=${menu.vh}` : '菜单未出现（上一条已判失败），不冒充通过', 'interaction')
          check('menu-items-hittable', menu.visible === true && menu.items > 0 && menu.itemsHit === menu.items, `items=${menu.items} hittable=${menu.itemsHit}`, 'interaction')
          if (menu.visible === true) {
            const closed = await closeMoreMenu(cdp, sid)
            raw.menuClosed = closed
            check('menu-no-leftover', closed.menuOpenAttr === null, `titleRow[data-meow-smooth-menu-open]=${closed.menuOpenAttr}`, 'safety')
          } else {
            skip('menu-no-leftover', '菜单从未打开（menu-visible 已判失败）→ 无残留可判，不冒充通过', 'safety')
          }
          const after = await measureAt(cdp, sid, { width: 390, height: 844 })
          const scrollers = after.titleRowChain.filter((c) => c.overflowX !== 'visible')
          check('no-scroll-container-in-titlerow', scrollers.length === 0,
            scrollers.length === 0 ? `链上 ${after.titleRowChain.length} 层全 visible` : `出现滚动容器：${scrollers.map((c) => `${c.tag}.${c.cls}=${c.overflowX}`).join(',')}`, 'layout')

          // ---- E 长附加名（390；文本注入只压排版规则，kind=layout-injected 明示"非端到端语义"）----
          const longLabels = await measureWithLongLabels(cdp, sid)
          raw.longLabels390 = longLabels
          assertLayoutIntegrity('390px/longLabels', longLabels, 'layout-injected')

          // ---- F 动态 DOM 条目增删（390）----
          const beforeEntries = (await measureAt(cdp, sid, { width: 390, height: 844 })).entries.map((e) => e.kind).sort().join('/')
          const removed = await measureAfterEntryRemoved(cdp, sid)
          raw.entryRemoved390 = removed
          assertLayoutIntegrity('390px/entryRemoved', removed, 'layout-injected')
          const restoredKinds = (await measureAt(cdp, sid, { width: 390, height: 844 })).entries.map((e) => e.kind).sort().join('/')
          check('entry-remove-restore-healthy', restoredKinds === beforeEntries, `移除→放回后条目=${restoredKinds} 原=${beforeEntries}`, 'safety')

          // ---- G 767/768 反复跨断点（不得有迟滞/漂移）----
          const cross = []
          for (const w of [767, 768, 767, 768]) cross.push({ w, g: simplify(await measureAt(cdp, sid, { width: w, height: 900, dsf: 1 })) })
          raw.crossBreakpoint = cross
          const sameAs = (a, b) => near(a.header?.h, b.header?.h) && near(a.tabs?.y, b.tabs?.y) && near(a.row1.crumbs?.y, b.row1.crumbs?.y) && near(a.row1.utilities?.y, b.row1.utilities?.y)
          check('cross-breakpoint-stable(767)', sameAs(cross[0].g, cross[2].g),
            `两次 767：header.h ${px(cross[0].g.header?.h)}/${px(cross[2].g.header?.h)} tabs.y ${px(cross[0].g.tabs?.y)}/${px(cross[2].g.tabs?.y)}`, 'layout')
          check('cross-breakpoint-stable(768)', sameAs(cross[1].g, cross[3].g) && sameAs(cross[1].g, goldenBefore[768]),
            `两次 768：header.h ${px(cross[1].g.header?.h)}/${px(cross[3].g.header?.h)}（基线 ${px(goldenBefore[768]?.header?.h)}）`, 'layout')

          // ---- ≥768 golden A/B（**在 FAB 交互之前**：纯排版对比，必须与基线同 sidebar 态）----
          for (const w of WIDE) compareGolden(w, goldenBefore[w], simplify(await measureAt(cdp, sid, { width: w, height: 900, dsf: 1 })))

          // ---- H 真实 FAB：只在 furl（FAB 可见）态判标题 hit / 不遮挡；点按单独判"侧栏打开"，再用真实状态迁移还原并确认 ----
          const preFabG = await measureAt(cdp, sid, { width: 390, height: 844 })
          const preFab = await fabState(cdp, sid)
          const preSidebar = await sidebarExpanded(cdp, sid)
          raw.fabPre = { fab: preFab, sidebar: preSidebar }
          if (preFab.visible !== true) {
            skip('fab-furled-title-hit', `FAB 不可见（${JSON.stringify(preFab.rect ?? null)}）→ 本态不冒充交互证据`, 'interaction')
            skip('fab-title-not-overlapping', '同上', 'interaction')
            skip('fab-opens-sidebar', '同上', 'interaction')
          } else {
            const titleBox = preFabG.row1.title
            check('fab-furled-title-hit', titleBox !== null && titleBox.hit === true,
              `furled 态 title.hit=${titleBox?.hit} rect=[${px(titleBox?.x)}..${px(titleBox?.right)}]`, 'interaction')
            const fabOverlap = titleBox !== null
              && titleBox.x + 1 < preFab.rect.right && preFab.rect.x + 1 < titleBox.right
              && titleBox.y + 1 < preFab.rect.bottom && preFab.rect.y + 1 < titleBox.bottom
            check('fab-title-not-overlapping', fabOverlap === false,
              `title=[${px(titleBox?.x)},${px(titleBox?.y)}..${px(titleBox?.right)},${px(titleBox?.bottom)}] fab=[${px(preFab.rect.x)},${px(preFab.rect.y)}..${px(preFab.rect.right)},${px(preFab.rect.bottom)}]（几何不相交 = 真不遮挡）`, 'interaction')
            assertLayoutIntegrity('390px/furled', preFabG, 'interaction')

            const fabTap = await tapFab(cdp, sid)
            await sleep(1000)
            const postSidebar = await sidebarExpanded(cdp, sid)
            const postFab = await fabState(cdp, sid)
            raw.fabTap = { tap: fabTap, postSidebar: postSidebar, postFab: postFab }
            check('fab-opens-sidebar', postSidebar.collapsed !== preSidebar.collapsed || postSidebar.furled !== preSidebar.furled,
              `可信点按 FAB(${px(fabTap.x)},${px(fabTap.y)}) → sidebarCollapsed ${preSidebar.collapsed}→${postSidebar.collapsed}，furled ${preSidebar.furled}→${postSidebar.furled}，FAB 可见 ${preFab.visible}→${postFab.visible}`, 'interaction')

            // 还原：窄视口官方会自动收起侧栏；随后**确认**状态回到 furl 再继续后面的用例
            await measureAt(cdp, sid, { width: 1280, height: 900, dsf: 1 })
            await measureAt(cdp, sid, { width: 390, height: 844 })
            const restoredFab = await fabState(cdp, sid)
            const restoredSidebar = await sidebarExpanded(cdp, sid)
            raw.fabRestored = { fab: restoredFab, sidebar: restoredSidebar }
            check('fab-state-restored', restoredFab.visible === true,
              `还原后 FAB 可见=${restoredFab.visible} sidebarCollapsed=${restoredSidebar.collapsed} furled=${restoredSidebar.furled}`, 'safety')
            if (restoredFab.visible !== true) {
              skip('post-fab-layout-integrity', '状态未还原 → 后续几何不可比，不冒充通过', 'safety')
            } else {
              assertLayoutIntegrity('390px/afterFabRestore', await measureAt(cdp, sid, { width: 390, height: 844 }), 'interaction')
            }
          }

          // ---- 卸载（只测新模块自己的 disposer）----
          if (cand.status === 'loaded') {
            const d = await dispose(cdp, sid)
            raw.dispose = d
            const back = await measureAt(cdp, sid, { width: 390, height: 844 })
            raw.afterDispose390 = back
            compareGolden('390px/afterDispose', simplify(base390), simplify(back), 'safety')
            check('dispose-restores-sheets', back.sheets.total === base390.sheets.total,
              `style 数 ${base390.sheets.total}→${back.sheets.total}（foldCss ${base390.sheets.foldCss}→${back.sheets.foldCss}）`, 'safety')
            check('dispose-restores-attrs', JSON.stringify(back.attrs) === JSON.stringify(base390.attrs),
              `attrs ${JSON.stringify(base390.attrs)}→${JSON.stringify(back.attrs)}`, 'safety')
          } else {
            skip('dispose-restores-geometry', `候选缺失（${cand.status}）→ install 是 noop，无效果可回滚`, 'safety')
            skip('dispose-restores-sheets', `候选缺失（${cand.status}）→ 无注入可清理`, 'safety')
            skip('dispose-restores-attrs', `候选缺失（${cand.status}）→ 无属性可清理`, 'safety')
          }

          // ---- I 模块重复安装/卸载（只测新模块自己的 disposer）----
          if (cand.status === 'loaded') {
            for (let cycle = 1; cycle <= 2; cycle++) {
              const ins = await install(cdp, sid)
              check(`reinstall-${cycle}-returns-disposer`, ins.ok === true && ins.returnedFunction === true, JSON.stringify(ins), 'safety')
              const withCand = await measureAt(cdp, sid, { width: 390, height: 844 })
              check(`reinstall-${cycle}-sheet-single`, withCand.sheets.foldCss <= base390.sheets.foldCss + 1,
                `foldCss ${base390.sheets.foldCss}→${withCand.sheets.foldCss}（不得随重复安装累积）`, 'safety')
              const d = await dispose(cdp, sid)
              const back = await measureAt(cdp, sid, { width: 390, height: 844 })
              compareGolden(`390px/reinstall-${cycle}`, simplify(base390), simplify(back), 'safety')
              check(`reinstall-${cycle}-no-leftover`,
                JSON.stringify(back.attrs) === JSON.stringify(base390.attrs) && back.sheets.total === base390.sheets.total,
                `attrs ${JSON.stringify(back.attrs)} style 数 ${base390.sheets.total}→${back.sheets.total}`, 'safety')
              raw[`reinstall${cycle}`] = { install: ins, dispose: d, sheets: back.sheets }
            }
          } else {
            skip('reinstall-cycle', `候选缺失（${cand.status}）→ noop，无"重复安装"语义可测`, 'safety')
          }

          // ---- J 晚挂载：在隔离 fixture 内摘掉/放回 session slot（不需要新的真实会话）----
          await measureAt(cdp, sid, { width: 390, height: 844 })
          const beforeDetach = await measureAt(cdp, sid, { width: 390, height: 844 })
          const det = await detachSessionSlot(cdp, sid)
          const detached = det.ok === true ? await measureAt(cdp, sid, { width: 390, height: 844 }) : null
          const errsDetached = await readErrors(cdp, sid)
          const re = await reattachSessionSlot(cdp, sid)
          const reattached = await measureAt(cdp, sid, { width: 390, height: 844 })
          raw.lateMount = {
            before: simplify(beforeDetach),
            detached: detached === null ? null : simplify(detached),
            reattached: simplify(reattached),
            det, re,
          }
          if (det.ok !== true || re.ok !== true) {
            skip('late-mount-detach-reattach', `摘/放失败 det=${JSON.stringify(det)} re=${JSON.stringify(re)}`, 'safety')
          } else {
            check('late-mount-sheet-kept', detached.sheets.total === beforeDetach.sheets.total,
              `结构移除期间样式表仍在场：${beforeDetach.sheets.total} → ${detached.sheets.total}（样式常驻、由结构门槛决定生效）`, 'safety')
            check('late-mount-no-error', errsDetached.length === 0,
              `摘除期间页面错误 ${errsDetached.length} 条${errsDetached.length > 0 ? '：' + errsDetached.slice(0, 2).join(' | ') : ''}`, 'safety')
            check('late-mount-anchors-back', re.crumbs > 0, `放回后锚点恢复命中 ${re.crumbs}`, 'safety')
            compareGolden('390px/lateMount', simplify(beforeDetach), simplify(reattached), 'safety')
          }

          // ---- K 不识别结构安全退回（安装那一刻锚点已被改名）----
          await cdp.evaluate(sid, `(() => {
            const a = document.querySelector('[data-slot="conversation.session.header"]')
            if (a !== null) a.setAttribute('data-slot', 'conversation.session.header.RENAMED')
            return true
          })()`)
          const insRenamed = await install(cdp, sid)
          const gRenamed = await measureAt(cdp, sid, { width: 390, height: 844 })
          const errsRenamed = await readErrors(cdp, sid)
          await cdp.evaluate(sid, `(() => {
            const a = document.querySelector('[data-slot="conversation.session.header.RENAMED"]')
            if (a !== null) a.setAttribute('data-slot', 'conversation.session.header')
            return true
          })()`)
          raw.renamedSlot = gRenamed
          check('unknown-structure-install-ok', insRenamed.ok === true, JSON.stringify(insRenamed), 'safety')
          check('unknown-structure-no-error', errsRenamed.length === 0,
            `页面错误 ${errsRenamed.length} 条${errsRenamed.length > 0 ? '：' + errsRenamed.slice(0, 2).join(' | ') : ''}`, 'safety')
          check('unknown-structure-page-intact', gRenamed.doc.scrollW <= gRenamed.doc.clientW + 1,
            `doc.scrollW=${gRenamed.doc.scrollW} clientW=${gRenamed.doc.clientW}`, 'safety')
          const recovered = await cdp.evaluate(sid, `document.querySelectorAll('[data-slot="conversation.session.header"] [class*="_crumbs"]').length`)
          check('unknown-structure-recovers', recovered > 0, `改名还原后锚点恢复命中 ${recovered}`, 'safety')
          await dispose(cdp, sid)
        }
      }
    }
  }
} catch (e) {
  fail('runner-exception', String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e))
} finally {
  try { if (tab !== null) await tab.close() } catch { /* ignore */ }
  try { if (cdp !== null) cdp.close() } catch { /* ignore */ }
}

const failed = checks.filter((c) => c.status === 'FAIL')
const passed = checks.filter((c) => c.status === 'PASS')
const skipped = checks.filter((c) => c.status === 'SKIP')
exitCode = envFailed ? 3 : anchorDrift ? 4 : failed.length > 0 ? 1 : 0

const stamp = started.toISOString().replace(/[:.]/g, '-').slice(0, 19)
const kindOf = (k) => checks.filter((c) => c.kind === k)
const byKind = Object.fromEntries(
  ['layout', 'layout-injected', 'interaction', 'safety'].map((k) => [k, {
    pass: kindOf(k).filter((c) => c.status === 'PASS').length,
    fail: kindOf(k).filter((c) => c.status === 'FAIL').length,
    skip: kindOf(k).filter((c) => c.status === 'SKIP').length,
  }]),
)
const summary = {
  startedAt: started.toISOString(),
  base: BASE,
  candidate: candidateStatus,
  verdict: envFailed ? 'ENV' : anchorDrift ? 'ANCHOR-DRIFT' : failed.length > 0 ? 'RED' : 'GREEN',
  counts: { pass: passed.length, fail: failed.length, skip: skipped.length },
  byKind,
  checks,
  notes: [
    '候选缺失时 installMobileHeader 以 noop 运行：断言以"行为不达"失败，而非 import 错误。',
    '判据全部来自真实排版（rect/elementFromPoint/scrollWidth），不做 CSS 文本匹配。',
    '超长标签允许 ellipsis：不以 scrollW > clientW 判失败，只判不越界 + 文字非隐藏。',
    '无固定 header 高度上限断言（不新增需求）。',
    'kind 语义：layout=真实 DOM 真实排版的几何断言（不含用户操作）；layout-injected=注入文本/摘节点的排版压测（非端到端语义）；interaction=经 CDP Input 域派发可信输入后的断言；safety=容错与清理。',
    '据此：layout/layout-injected 通过**不能**当作"真实 GUI 交互通过"；只有 interaction 组是真实点按证据，且最终仍由 Lead 在真实 GUI 上复核。',
    '仅在隔离 browser context 的测试标签内操作；用户原标签未被 attach 或修改。',
  ],
}
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, `run-${stamp}.json`), JSON.stringify({ summary, raw }, null, 1))
const md = [
  `# header-mobile 回归 ${summary.verdict} — ${summary.startedAt}`,
  '',
  `- base: ${BASE}`,
  `- 候选状态: ${candidateStatus}`,
  `- PASS ${passed.length} / FAIL ${failed.length} / SKIP ${skipped.length}`,
  `- 分类：${Object.entries(byKind).map(([k, v]) => `${k}=${v.pass}/${v.fail}/${v.skip}`).join('  ')}  (PASS/FAIL/SKIP)`,
  '',
  '> 断言分类（防止把无交互的布局断言当 E2E）：`layout` = 真实 DOM + 真实排版几何，**不含用户操作**；',
  '> `layout-injected` = 注入文本/摘节点的排版压测，**非端到端语义**；`interaction` = CDP Input 域**可信输入**后的断言；',
  '> `safety` = 容错与清理。**只有 interaction 组构成真实交互证据**，最终验收由 Lead 在真实 GUI 复核。',
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
writeFileSync(join(OUT_DIR, `run-${stamp}.md`), md)
// 稳定入口：RED/GREEN 各留一份最新快照，方便 Lead 直接看
if (summary.verdict === 'RED') writeFileSync(join(OUT_DIR, 'RED.md'), md)
if (summary.verdict === 'GREEN') writeFileSync(join(OUT_DIR, 'GREEN.md'), md)

console.log(`\n--- ${summary.verdict}: PASS ${passed.length} / FAIL ${failed.length} / SKIP ${skipped.length} (candidate=${candidateStatus}) ---`)
console.log(`artifacts: ${OUT_DIR}/run-${stamp}.json|md`)
process.exit(exitCode)

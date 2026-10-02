#!/usr/bin/env node
/**
 * task-5 RED/GREEN：手机标题兼作侧栏入口。
 *
 * 契约：`src/title-sidebar-entry.ts` → `installTitleSidebarEntry(openSidebar: () => void): () => void`
 *   <768 且存在"普通当前标题 span"时：标题成为无图标的可聚焦可键盘操作入口、
 *   旧 FAB 隐藏且不占位、既有 header 56px 让位取消；click / Enter / Space 各**恰好**触发一次回调。
 *   ≥768：无标题交互、无样式改变。祖先面包屑/lineage 按钮不被劫持。
 *   无普通标题 / 无 callback / IME 隐藏 header 时：FAB 保留（安全 fallback）。
 *   晚挂载、断点往返、dispose 后 attrs 恢复原值。
 *
 * 运行：node scripts/test-header-mobile-title.mjs [baseUrl]
 * 退出码：0 全过 / 1 行为不达(RED) / 3 环境不可用
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { existsSync, readFileSync } from 'node:fs'
import { connect, sleep, tapSelector } from '../tests/header-mobile/cdp.mjs'
import { openGuiTab, ensureNonEmptySession, measureAt, startErrorWatch, readErrors, detachSessionSlot, reattachSessionSlot } from '../tests/header-mobile/fixture.mjs'
import { CTX_STUB, REACT_STUB, RUN_BUNDLE, RUN_DISPOSE_WINDOW, STEP_APPLY, STEP_CAPTURE, STEP_FACTORY, captureBundleText } from '../tests/header-mobile/integration.mjs'
import { ANCESTOR_ARM, ANCESTOR_CLICK, CLICK_SYNTH, INJECT_SYNTH, MAKE_TITLE_INTERACTIVE, OPS, READ_CALLS, REMOVE_SYNTH, RESTORE_TITLE, SNAP, TRIGGER, loadEntry, setIme } from '../tests/header-mobile-title/entry.mjs'

const BASE = process.argv[2] ?? process.env.MEOW_BASE ?? 'http://192.168.1.100:3080'
const OUT_DIR = fileURLToPath(new URL('../artifacts/header-mobile-title', import.meta.url))
const NARROW = { width: 390, height: 844, dsf: 3 }
const WIDE = { width: 1024, height: 900, dsf: 1 }

const checks = []
const raw = {}
const check = (name, ok, detail, kind = 'title-entry') => {
  checks.push({ name, status: ok ? 'PASS' : 'FAIL', detail, kind })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`)
}
const skip = (name, detail, kind = 'title-entry') => {
  checks.push({ name, status: 'SKIP', detail, kind })
  console.log(`SKIP ${name} — ${detail}`)
}
const px = (v) => (typeof v === 'number' ? v.toFixed(1) : String(v))
const same = (a, b, tol = 1) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol


/** 侧栏收起态：真实 DOM 上的 data-sidebar-collapsed（由运行中界面维护）。 */
const SIDEBAR_STATE = `(() => {
  const el = document.querySelector('[data-sidebar-collapsed]')
  return JSON.stringify({
    present: el !== null,
    value: el === null ? null : el.getAttribute('data-sidebar-collapsed'),
    tag: el === null ? null : el.tagName,
    cls: el === null ? null : String(el.className).slice(0, 30),
  })
})()`

const TITLE_SEL = '[data-slot="conversation.session.header"] [class*="_crumbCurrent"]'

/**
 * 真实构建产物集成检查（新隔离标签）：`lib/client.js` 的 apply 是否把标题入口接进生命周期 ——
 * 真实点击标题必须让 `data-sidebar-collapsed` 移除；真拆除后必须清理入口属性和样式。
 */
async function runIntegrationPhase(cdp, baseUrl) {
  const out = []
  const push = (name, status, detail) => {
    const st = status === true ? 'PASS' : status === false ? 'FAIL' : status
    out.push({ name, status: st, detail, kind: 'integration' })
    console.log(`${st} ${name} — ${detail}`)
  }
  const bundlePath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
  if (!existsSync(bundlePath)) {
    push('client-bundle-present', 'SKIP', `缺少真实构建产物 ${bundlePath}`)
    return out
  }
  const patched = captureBundleText(readFileSync(bundlePath, 'utf8'))
  const { tab: tab2 } = await openGuiTab(cdp, { baseUrl, ...NARROW })
  try {
    const sid2 = tab2.sessionId
    await startErrorWatch(cdp, sid2)
    const ses = await ensureNonEmptySession(cdp, sid2)
    if (!ses.ok) {
      push('client-integration-runnable', 'SKIP', '拿不到非空会话 header')
      return out
    }
    await measureAt(cdp, sid2, NARROW)
    await cdp.evaluate(sid2, `${RUN_BUNDLE}\n${REACT_STUB}\n${CTX_STUB}\nglobalThis.__meowBundleText = ${JSON.stringify(patched)}; true`)
    const cap = JSON.parse(await cdp.evaluate(sid2, STEP_CAPTURE))
    const fac = JSON.parse(await cdp.evaluate(sid2, STEP_FACTORY))
    if (cap.factoryType !== 'function' || fac.ok !== true) {
      push('client-apply-ok', 'SKIP', `真实产物未就绪：capture=${JSON.stringify(cap)} factory=${JSON.stringify(fac)}`)
      return out
    }
    // layout 是宿主边界：委托页面原生按钮，不能用 no-op 验证侧栏打开。
    await cdp.evaluate(sid2, `(() => {
      const original = globalThis.__meowCtx
      globalThis.__meowCtx = () => {
        const built = original()
        built.ctx.layout.toggleSidebar = () => {
          const buttons = document.querySelector('[data-slot="sidebar"] > *')?.firstElementChild?.querySelectorAll('button')
          if (!buttons?.length) throw new Error('native sidebar toggle missing')
          buttons[buttons.length - 1].click()
        }
        return built
      }
      return true
    })()`)
    const apply = JSON.parse(await cdp.evaluate(sid2, STEP_APPLY))
    push('client-apply-ok', apply.applyError === null,
      `真实 apply：applyError=${apply.applyError} stage=${apply.applyStage} headerSheets=${apply.headerSheets} effects=${apply.effectsCount}`)

    const before = JSON.parse(await cdp.evaluate(sid2, SIDEBAR_STATE))
    const tap = await tapSelector(cdp, sid2, TITLE_SEL)
    await sleep(900)
    const afterClick = JSON.parse(await cdp.evaluate(sid2, SIDEBAR_STATE))
    raw.integration = { before, tap, afterClick }
    const clickChanged = before.present !== afterClick.present || before.value !== afterClick.value
    push('title-click-opens-sidebar', clickChanged,
      `可信点按标题(${px(tap?.x)},${px(tap?.y)})后 data-sidebar-collapsed ${JSON.stringify(before)} → ${JSON.stringify(afterClick)}（应被移除/改变）`)

    await cdp.evaluate(sid2, RUN_DISPOSE_WINDOW)
    await sleep(1000)
    const afterDispose = JSON.parse(await cdp.evaluate(sid2, SIDEBAR_STATE))
    raw.integration.afterDispose = afterDispose
    const cleaned = JSON.parse(await cdp.evaluate(sid2, `JSON.stringify({
      claimed: document.querySelectorAll('[data-meow-smooth-title-claimed]').length,
      sheets: document.querySelectorAll('style[data-meow-title-sidebar-entry-css]').length,
      marker: document.documentElement.hasAttribute('data-meow-smooth-title-entry')
    })`))
    push('dispose-removes-title-entry', clickChanged && cleaned.claimed === 0 && cleaned.sheets === 0 && !cleaned.marker,
      `移除标题增强，不强行撤销用户已打开的宿主侧栏：${JSON.stringify(cleaned)}`)

  } finally {
    try { await tab2.close() } catch { /* ignore */ }
  }
  return out
}

const started = new Date()
let cdp = null
let tab = null
let envFailed = false
let sid = null

const snap = async () => JSON.parse(await cdp.evaluate(sid, SNAP))
const calls = async () => cdp.evaluate(sid, READ_CALLS)
const installWith = async (kind) => JSON.parse(await cdp.evaluate(sid, `window.__tsInstallWith(${JSON.stringify(kind)})`))
const disposeNow = async () => JSON.parse(await cdp.evaluate(sid, `window.__tsDisposeNow()`))
const at = (vp) => measureAt(cdp, sid, vp)

/**
 * 回到 390 并**等 furl/FAB 状态稳定**再取快照。
 * 断点往返（390→1024→390）后侧栏收起与 FAB 出现有 ~500ms 的同步延迟，
 * 不 settle 会把"状态未就绪"误判成"FAB 不该隐藏/attrs 没恢复"。
 */
async function settleNarrow() {
  await at(NARROW)
  for (let i = 0; i < 16; i++) {
    const s = await snap()
    if (s.fabVisible === true || s.fabFound === false) return s
    await sleep(250)
  }
  return snap()
}

/** 触发一次交互，返回 callback 增量（"恰好一次"判据用它）。 */
async function deltaOf(expr) {
  const before = await calls()
  const r = JSON.parse(await cdp.evaluate(sid, expr))
  await sleep(150)
  const after = await calls()
  return { delta: after - before, r }
}

try {
  cdp = await connect()
  if (cdp === null) {
    envFailed = true
    console.log('ENV FAIL — CDP 端点不可达')
  } else {
    const opened = await openGuiTab(cdp, { baseUrl: BASE, ...NARROW })
    tab = opened.tab
    sid = tab.sessionId
    if (!opened.booted) {
      envFailed = true
      console.log('ENV FAIL — GUI 未挂载')
    } else {
      await startErrorWatch(cdp, sid)
      const session = await ensureNonEmptySession(cdp, sid)
      if (!session.ok) {
        envFailed = true
        console.log('ENV FAIL — 拿不到非空会话 header')
      } else {
        await at(NARROW)
        const s0 = await snap()
        raw.beforeNarrow = s0
        await at(WIDE)
        const w0 = await snap()
        raw.beforeWide = w0
        await settleNarrow() // 回到窄屏必须等 furl/FAB 回位，否则 FAB 断言会被真空通过
        console.log(`baseline@390: title=${s0.titleTag} focusable=${s0.titleFocusable} fabVisible=${s0.fabVisible} header.x=${px(s0.headerRect?.x)} clusterInteractive=${s0.clusterInteractive}`)

        // ---- 载入候选 ----
        const loaded = await loadEntry(cdp, sid)
        raw.candidate = loaded
        console.log(`candidate: ${loaded.status}${loaded.detail === undefined ? '' : ' (' + loaded.detail + ')'}`)
        await cdp.evaluate(sid, OPS)
        const resetTitleAttrs = () => cdp.evaluate(sid, `(() => {
          const t = window.__tsTitle()
          if (t !== null) { t.removeAttribute('role'); t.removeAttribute('tabindex'); t.removeAttribute('aria-label') }
          return true
        })()`)
        const isNoop = loaded.status !== 'loaded'
        if (isNoop) console.log('候选降级为 noop —— 行为断言以"行为不达"失败（RED），不是 import 错误')

        // ---- ① 激活态：可聚焦 / 无标题图标 / FAB 隐藏 / 56px 让位取消 ----
        const r1 = await installWith('fn')
        if (isNoop) skip('install-returns-disposer', `候选缺失（${loaded.status}）→ noop，无法验证真实 disposer`, 'safety')
        else check('install-returns-disposer', r1.returned === true && r1.threw === null, JSON.stringify(r1), 'safety')
        const s1 = await snap()
        raw.afterNarrow = s1
        check('title-focusable-with-button-semantics', s1.titleFocusable === true,
          `可聚焦=tabIndex>=0 且 button 语义：tabIndex=${s1.titleTabIndex} role=${s1.titleRole} tag=${s1.titleTag}（attrs=${JSON.stringify(s1.titleAttrs)}）`)
        check('title-has-no-menu-glyph', s1.glyphBesideTitle === null,
          `安装前 ${JSON.stringify(s0.glyphBesideTitle)} → 安装后 ${JSON.stringify(s1.glyphBesideTitle)}（标题旁不应出现额外图标）`)
        if (s0.fabVisible === true) {
          check('legacy-fab-hidden', s1.fabVisible === false,
            `FAB visible ${s0.fabVisible} → ${s1.fabVisible}（display=${s1.fabDisplay} rect=${JSON.stringify(s1.fabRect)}）`)
        } else {
          skip('legacy-fab-hidden', `基线 FAB 不可见（fabFound=${s0.fabFound}）→ 本态不判`)
        }
        const padBefore = Number.parseFloat(s0.crumbsPaddingInlineStart ?? '0')
        if (padBefore >= 40) {
          check('header-56px-clearance-cancelled', Number.parseFloat(s1.crumbsPaddingInlineStart ?? '0') <= 8,
            `_crumbs computed padding-inline-start ${s0.crumbsPaddingInlineStart} → ${s1.crumbsPaddingInlineStart}（56px 让位应取消）`)
        } else {
          skip('header-56px-clearance-cancelled',
            `_crumbs computed padding-inline-start=${s0.crumbsPaddingInlineStart}（padding-left=${s0.crumbsPaddingLeft} crumb=${s0.crumbPaddingLeft} header=${s0.headerPaddingLeft}），当前 live 态没有 56px 让位可取消 → 不冒充通过`)
        }

        // ---- ② click / Enter / Space 各恰好一次 ----
        const dClick = await deltaOf(`${TRIGGER}('click', '')`)
        check('title-click-once', dClick.delta === 1, `click 触发 ${dClick.delta} 次（期望 1），dispatched=${dClick.r.dispatched}`)
        const dEnter = await deltaOf(`${TRIGGER}('key', 'Enter')`)
        check('title-enter-once', dEnter.delta === 1, `Enter 触发 ${dEnter.delta} 次（期望 1），focused=${dEnter.r.focused}`)
        const dSpace = await deltaOf(`${TRIGGER}('key', ' ')`)
        check('title-space-once', dSpace.delta === 1, `Space 触发 ${dSpace.delta} 次（期望 1），focused=${dSpace.r.focused}`)

        // ---- ③ ≥768：无交互、无样式改变 ----
        await at(WIDE)
        const w1 = await snap()
        raw.afterWide = w1
        const dWide = await deltaOf(`${TRIGGER}('click', '')`)
        check('wide-no-callback', dWide.delta === 0, `1024 下 click 触发 ${dWide.delta} 次（期望 0），dispatched=${dWide.r.dispatched}`)
        check('wide-title-attrs-unchanged', JSON.stringify(w1.titleAttrs) === JSON.stringify(w0.titleAttrs),
          `title attrs ${JSON.stringify(w0.titleAttrs)} → ${JSON.stringify(w1.titleAttrs)}`)
        check('wide-geometry-unchanged', same(w0.headerRect?.h, w1.headerRect?.h) && same(w0.rowRect?.h, w1.rowRect?.h),
          `header.h ${px(w0.headerRect?.h)}→${px(w1.headerRect?.h)} row.h ${px(w0.rowRect?.h)}→${px(w1.rowRect?.h)}`)
        await at(NARROW)

        // ---- ④ dispose 恢复 attrs 原值 ----
        await disposeNow()
        const s2 = await settleNarrow()
        raw.afterDispose = s2
        check('dispose-restores-title-attrs', JSON.stringify(s2.titleAttrs) === JSON.stringify(s0.titleAttrs),
          `title attrs ${JSON.stringify(s0.titleAttrs)} → ${JSON.stringify(s2.titleAttrs)}`)
        check('dispose-restores-fab', s2.fabVisible === s0.fabVisible,
          `FAB visible ${s0.fabVisible} → ${s2.fabVisible}`)
        const newKeys = Object.keys(s2.rootAttrs ?? {}).filter((k) => !(k in (s0.rootAttrs ?? {})))
        const changedKeys = Object.keys(s0.rootAttrs ?? {}).filter((k) => (s2.rootAttrs ?? {})[k] !== s0.rootAttrs[k])
        check('dispose-restores-root-attrs', newKeys.length === 0,
          newKeys.length === 0
            ? `documentElement 无新增属性键（布局态标记变化：${changedKeys.join(',') || '无'}）`
            : `dispose 后残留新增键：${newKeys.join(',')}`)

        // ---- ⑤ 无 callback：FAB 保留 ----
        const rNoCb = await installWith('none')
        const s3 = await settleNarrow()
        raw.noCallback = s3
        if (isNoop) skip('no-callback-safe', `候选缺失（${loaded.status}）→ noop，fallback 项在 noop 下无意义`, 'safety')
        else check('no-callback-safe', rNoCb.threw === null && (s0.fabVisible !== true || s3.fabVisible === true),
          `threw=${rNoCb.threw} FAB visible ${s0.fabVisible} → ${s3.fabVisible}（无 callback 应保留 FAB fallback）`, 'safety')
        await disposeNow()

        // ---- ⑥ 晚挂载：先摘掉会话头再安装，放回后应生效 ----
        const det = await detachSessionSlot(cdp, sid)
        const rLate = await installWith('fn')
        await sleep(300)
        const s4 = await snap()
        raw.lateMountBeforeMount = s4
        const re = await reattachSessionSlot(cdp, sid)
        await sleep(500)
        const dLate = await deltaOf(`${TRIGGER}('click', '')`)
        if (isNoop) skip('late-mount-installs-cleanly', `候选缺失（${loaded.status}）→ noop，无"安装"可验`, 'safety')
        else check('late-mount-installs-cleanly', det.ok === true && re.ok === true && rLate.threw === null,
          `detach=${JSON.stringify(det)} reattach=${JSON.stringify(re)} install.threw=${rLate.threw}（无标题时 FAB 应保留：${s4.fabVisible}）`, 'safety')
        check('late-mount-title-click-once', dLate.delta === 1,
          `挂载后 click 触发 ${dLate.delta} 次（期望 1，无需重新 install）`)
        await disposeNow()

        // ---- ⑦ IME 态：本模块不得**额外**改变 FAB（与 noop 基线差分；不要求它可见）----
        await disposeNow()
        await cdp.evaluate(sid, setIme(true))
        const sImeBase = await settleNarrow()
        const rIme = await installWith('fn')
        const sImeMod = await settleNarrow()
        raw.imeHidden = { noModule: sImeBase, installed: sImeMod }
        if (isNoop) {
          skip('ime-state-no-extra-fab-change', `候选缺失（${loaded.status}）→ noop，差分项在 noop 下无意义`, 'safety')
        } else {
          check('ime-state-no-extra-fab-change', rIme.threw === null && sImeMod.fabVisible === sImeBase.fabVisible,
            `同一 IME 态下 FAB 可见性 noop基线=${sImeBase.fabVisible} → 安装后=${sImeMod.fabVisible}（既有规则本就是 IME 下藏 FAB，模块不得额外改变）`, 'safety')
        }
        await cdp.evaluate(sid, setIme(false))
        await disposeNow()

        // ---- ⑧ 祖先面包屑不被劫持（放最后：点击可能触发导航）----
        await installWith('fn')
        const armed = JSON.parse(await cdp.evaluate(sid, ANCESTOR_ARM))
        raw.ancestor = armed
        if (armed.found !== true) {
          skip('ancestor-crumb-not-hijacked', '本会话没有祖先面包屑按钮（无父会话），无法验证')
        } else {
          const hit = JSON.parse(await cdp.evaluate(sid, ANCESTOR_CLICK))
          await sleep(400)
          check('ancestor-crumb-not-hijacked', hit.ancestorHits >= 1 && hit.calls === 0,
            `祖先按钮「${armed.label}」自身收到 ${hit.ancestorHits} 次 click；标题回调 ${hit.calls} 次（期望 0）`)
        }
        await disposeNow()

        // ---- ⑨ 隔离合成：祖先面包屑 / lineage 控件不被劫持（不触发任何真实导航）----
        await installWith('fn')
        const inj = JSON.parse(await cdp.evaluate(sid, INJECT_SYNTH))
        if (inj.ok !== true) {
          skip('ancestor-lineage-not-hijacked', `合成节点注入失败：${JSON.stringify(inj)}`)
        } else {
          const hit = JSON.parse(await cdp.evaluate(sid, CLICK_SYNTH))
          check('ancestor-lineage-not-hijacked', hit.ancestorHits === 1 && hit.lineageHits === 1 && hit.titleCallsDelta === 0,
            `合成祖先按钮自身收到 ${hit.ancestorHits}/1 次、lineage 按钮 ${hit.lineageHits}/1 次；标题回调 ${hit.titleCallsDelta} 次（期望 0）`)
          await cdp.evaluate(sid, REMOVE_SYNTH)
        }
        await disposeNow()

        // ---- ⑩ 标题本身已可交互（非"普通 span"）→ FAB 安全 fallback、不得双触发 ----
        const mk = JSON.parse(await cdp.evaluate(sid, MAKE_TITLE_INTERACTIVE))
        await installWith('fn')
        await sleep(300)
        const sInt = await settleNarrow()
        const dInt = await deltaOf(`${TRIGGER}('click', '')`)
        raw.interactiveTitle = { mk, snapshot: sInt, delta: dInt.delta }
        if (isNoop) {
          skip('interactive-title-fallback', `候选缺失（${loaded.status}）→ noop，fallback 项在 noop 下无意义`, 'safety')
        } else {
          check('interactive-title-fallback', mk.ok === true && sInt.fabVisible === true && dInt.delta <= 1,
            `标题换成 ${mk.tag}(tabIndex=${mk.tabIndex}) → FAB visible=${sInt.fabVisible}（应保留 fallback）；click 触发 ${dInt.delta} 次（不得双触发）`, 'safety')
        }
        await disposeNow()
        await cdp.evaluate(sid, RESTORE_TITLE)
        await sleep(400)

        // ---- ⑪ detach 只还原"自己写的值"：外部接管后 dispose 不得覆盖 ----
        await installWith('fn')
        await sleep(250)
        await cdp.evaluate(sid, `window.__tsSetExternalAttrs()`)
        const extBefore = JSON.parse(await cdp.evaluate(sid, `window.__tsState()`))
        await disposeNow()
        await sleep(250)
        const extAfter = JSON.parse(await cdp.evaluate(sid, `window.__tsState()`))
        raw.detachExternal = { before: extBefore, after: extAfter }
        check('detach-keeps-external-attrs',
          extAfter.role === 'link' && extAfter.tabindex === '-1' && extAfter.ariaLabel === '外部标签',
          `外部接管(role=link/tabindex=-1/aria-label=外部标签) → dispose 后 role=${extAfter.role} tabindex=${extAfter.tabindex} aria-label=${extAfter.ariaLabel}（不得还原原值或删除）`, 'safety')
        await resetTitleAttrs()

        // ---- ⑫ sync 释放而非抢回 ----
        await installWith('fn')
        await sleep(250)
        await cdp.evaluate(sid, `window.__tsSetRole('link')`)
        await sleep(450)
        const rel = JSON.parse(await cdp.evaluate(sid, `window.__tsState()`))
        raw.syncRelease = rel
        check('sync-releases-when-title-becomes-interactive',
          rel.role === 'link' && rel.marker === false && rel.fabVisible === true,
          `外部把 role 改成 link → role=${rel.role}（不得抢回 button）、入口标记=${rel.marker}（应释放）、FAB 可见=${rel.fabVisible}`, 'safety')
        await disposeNow()
        await resetTitleAttrs()

        // ---- ⑬ aria-label 跟随标题文本 ----
        await installWith('fn')
        await sleep(250)
        const newText = 'TEST_TITLE_' + String(Date.now()).slice(-5)
        await cdp.evaluate(sid, `window.__tsSetText(${JSON.stringify(newText)})`)
        await sleep(450)
        const al = JSON.parse(await cdp.evaluate(sid, `window.__tsState()`))
        raw.ariaFollow = { newText, state: al }
        check('aria-label-follows-title-text', al.ariaLabel === newText,
          `标题文本改为 ${newText} → aria-label=${al.ariaLabel}（应跟随新文本）`, 'safety')
        await disposeNow()

        // ---- ⑭ 未被认领的元素不得有图标 ----
        await installWith('fn')
        await sleep(250)
        const insCur = JSON.parse(await cdp.evaluate(sid, `window.__tsInsertCurrent()`))
        await sleep(350)
        const gClaimed = JSON.parse(await cdp.evaluate(sid, `window.__tsPseudoOf('[data-slot="conversation.session.header"] [class*="_crumbCurrent"]:not([class*="synth_"])')`))
        const gUnclaimed = JSON.parse(await cdp.evaluate(sid, `window.__tsPseudoOf('[class*="synth_crumbCurrent"]')`))
        raw.unclaimedGlyph = { insCur, claimed: gClaimed, unclaimed: gUnclaimed }
        check('unclaimed-title-has-no-glyph',
          gClaimed.found === true && gClaimed.content === 'none' && gUnclaimed.found === true && gUnclaimed.content === 'none',
          `已认领 X::before content=${JSON.stringify(gClaimed.content)}（必须为 none）；未认领 Y::before content=${JSON.stringify(gUnclaimed.content)}（必须为 none）`, 'safety')
        await cdp.evaluate(sid, `window.__tsRemoveCurrent()`)
        await disposeNow()

        // ---- ⑮ subagent 标题不得被认领 ----
        await resetTitleAttrs()
        await cdp.evaluate(sid, `window.__tsAddSubagent()`)
        await sleep(200)
        await installWith('fn')
        await sleep(400)
        const sub = JSON.parse(await cdp.evaluate(sid, `window.__tsState()`))
        raw.subagentTitle = sub
        check('subagent-title-not-claimed',
          sub.role === null && sub.tabindex === null && sub.marker === false && sub.fabVisible === true,
          `标题带 _crumbSubagent → role=${sub.role} tabindex=${sub.tabindex} 入口标记=${sub.marker} FAB 可见=${sub.fabVisible}（应保留 FAB fallback）`, 'safety')
        await disposeNow()
        await cdp.evaluate(sid, `window.__tsRemoveSubagent()`)
        await sleep(350)

        // ---- ⑯ 可见性变化要被观察（隐藏→释放，恢复→重新认领）----
        await resetTitleAttrs()
        await installWith('fn')
        await sleep(300)
        const visOn = JSON.parse(await cdp.evaluate(sid, `window.__tsState()`))
        await cdp.evaluate(sid, `window.__tsSetDisplay('none')`)
        await sleep(600)
        const visOff = JSON.parse(await cdp.evaluate(sid, `window.__tsState()`))
        await cdp.evaluate(sid, `window.__tsSetDisplay('')`)
        await sleep(700)
        const visBack = JSON.parse(await cdp.evaluate(sid, `window.__tsState()`))
        raw.visibility = { on: visOn, hidden: visOff, restored: visBack }
        check('visibility-hide-releases', visOff.marker === false && visOff.fabVisible === true,
          `标题 display:none → 入口标记=${visOff.marker}（应移除）FAB 可见=${visOff.fabVisible}（应回到可见）`, 'safety')
        check('visibility-restore-reclaims', visBack.marker === true && visBack.role === 'button' && visBack.tabindex === '0' && visBack.fabVisible === false,
          `恢复 display → 入口标记=${visBack.marker} role=${visBack.role} tabindex=${visBack.tabindex} FAB 可见=${visBack.fabVisible}（应重新认领）`, 'safety')
        await disposeNow()

        // ---- ⑰ Space 长按：两次 keydown 都必须 preventDefault，回调恰好一次 ----
        await installWith('fn')
        await sleep(300)
        const beforeRep = await calls()
        const rep = JSON.parse(await cdp.evaluate(sid, `window.__tsSpaceRepeat()`))
        await sleep(250)
        const afterRep = await calls()
        raw.spaceRepeat = { rep, delta: afterRep - beforeRep }
        check('space-repeat-prevented-single-call',
          rep.ok === true && rep.firstPrevented === true && rep.secondPrevented === true && (afterRep - beforeRep) === 1,
          `两次 Space keydown（第二次 repeat:true）defaultPrevented=${rep.firstPrevented}/${rep.secondPrevented}（均应为 true，防长按滚动），回调 ${afterRep - beforeRep} 次（期望 1）`)
        await disposeNow()

        // ---- ⑲ 真实 lib/client.js 集成：点击标题真的开侧栏、dispose 清理入口 ----
        for (const c of await runIntegrationPhase(cdp, BASE)) checks.push(c)

        // ---- 错误清理 ----
        const errs = await readErrors(cdp, sid)
        if (errs.length === 0) check('page-errors-clean', true, '执行期间页面无未捕获错误', 'safety')
        else check('page-errors-clean', false, `页面错误 ${errs.length} 条：${errs.slice(0, 2).join(' | ')}`, 'safety')

        // ---- ⑱ 整棵 <header> 被替换后仍要发现新标题（破坏性，放最后）----
        await installWith('fn')
        await sleep(300)
        const repH = JSON.parse(await cdp.evaluate(sid, `window.__tsReplaceHeader()`))
        await sleep(800)
        const afterRepH = JSON.parse(await cdp.evaluate(sid, `window.__tsState()`))
        const dRepH = await deltaOf(`${TRIGGER}('click', '')`)
        raw.headerReplaced = { repH, state: afterRepH, delta: dRepH.delta }
        check('header-replaced-rediscovers-title',
          repH.ok === true && afterRepH.titleFound === true && afterRepH.role === 'button' && afterRepH.tabindex === '0' && dRepH.delta === 1,
          `整棵 <header> 换新后：找到标题=${afterRepH.titleFound} role=${afterRepH.role} tabindex=${afterRepH.tabindex}；click 触发 ${dRepH.delta} 次（期望 1）`)
        await disposeNow()
        raw.errorsAfterHeaderSwap = await readErrors(cdp, sid)
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
const verdict = envFailed && failed.length === 0 ? 'ENV' : failed.length > 0 ? 'RED' : 'GREEN'
const exitCode = verdict === 'ENV' ? 3 : failed.length > 0 ? 1 : 0

const stamp = started.toISOString().replace(/[:.]/g, '-').slice(0, 19)
const md = [
  `# 标题侧栏入口 ${verdict} — ${started.toISOString()}`,
  '',
  `- base: ${BASE}`,
  `- 候选: ${raw.candidate?.status ?? 'unknown'}`,
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
writeFileSync(join(OUT_DIR, `title-${stamp}.json`), JSON.stringify({ verdict, checks, raw }, null, 1))
writeFileSync(join(OUT_DIR, `title-${stamp}.md`), md)
if (verdict === 'RED') writeFileSync(join(OUT_DIR, 'TITLE-RED.md'), md)
if (verdict === 'GREEN') writeFileSync(join(OUT_DIR, 'TITLE-GREEN.md'), md)

console.log(`\n--- ${verdict}: PASS ${passed.length} / FAIL ${failed.length} / SKIP ${skipped.length} ---`)
console.log(`artifacts: ${OUT_DIR}/title-${stamp}.json|md`)
process.exit(exitCode)

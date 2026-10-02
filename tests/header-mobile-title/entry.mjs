/**
 * 新需求（task-5）：标题兼作侧栏入口。
 *
 * 被测接口：`src/title-sidebar-entry.ts` → `installTitleSidebarEntry(openSidebar: () => void): () => void`
 * 加载方式：esbuild 打成 IIFE 注入隔离浏览器标签，执行**真实** install。
 * 模块不存在 → noop（断言以"行为不达"失败，不是 import 错误）。
 *
 * 锚点（全部取自运行中 0.2.0-rc.2 的 live DOM，勿改）：
 *  - 会话头 slot：`[data-slot="conversation.session.header"]`
 *  - 当前标题：`[class*="_crumbCurrent"]`（普通会话是 span；子代理会带 `_crumbSubagent`）
 *  - 标题行：`[class*="_titleRow"]`；标题簇：`[class*="_titleCluster"]`
 *  - 祖先面包屑：`button[class*="_crumb"]`；旧入口：`[data-meow-smooth-fab]`
 *  - IME 标记：documentElement 上的 `data-meow-smooth-ime`
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DEFAULT_ENTRY = fileURLToPath(new URL('../../src/title-sidebar-entry.ts', import.meta.url))
const GLOBAL_NAME = '__meowTitleEntry'
const EXPORT_NAME = 'installTitleSidebarEntry'

/** 打成浏览器可执行的 IIFE。 */
async function bundle(entry) {
  const esbuild = await import('esbuild')
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: GLOBAL_NAME,
    platform: 'browser',
    target: 'es2022',
    logLevel: 'silent',
    metafile: true,
  })
  const externals = new Set()
  for (const out of Object.values(result.metafile.outputs)) {
    for (const [spec, info] of Object.entries(out.imports ?? {})) {
      if (info.external === true) externals.add(spec)
    }
  }
  return { code: result.outputFiles[0].text, externals: [...externals] }
}

/** 准备候选并注入页面：`window.__TitleEntry = { status, real, installWith, disposeNow }`。 */
export async function loadEntry(cdp, sessionId, { entry = DEFAULT_ENTRY } = {}) {
  let status = 'loaded'
  let detail
  let code = ''
  if (!existsSync(entry)) {
    status = 'missing'
    detail = `模块不存在：${entry}`
  } else {
    try {
      const built = await bundle(entry)
      if (built.externals.length > 0) {
        status = 'external-deps'
        detail = `外部依赖无法在页面内解析：${built.externals.join(', ')}`
      } else {
        code = built.code
      }
    } catch (e) {
      status = 'failed'
      detail = String(e.message).slice(0, 300)
    }
  }
  await cdp.evaluate(
    sessionId,
    `(() => {
      ${code}
      const exp = (typeof ${GLOBAL_NAME} !== 'undefined' && ${GLOBAL_NAME} !== null) ? ${GLOBAL_NAME} : null
      const real = exp !== null && typeof exp.${EXPORT_NAME} === 'function' ? exp.${EXPORT_NAME} : null
      window.__tsCalls = 0
      window.__tsDispose = null
      window.__TitleEntry = { status: ${JSON.stringify(status)}, real: real !== null }
      window.__tsInstallWith = function (kind) {
        window.__tsCalls = 0
        const cb = kind === 'none' ? undefined : function () { window.__tsCalls++ }
        const fn = real !== null ? real : function () { return function () {} }
        let d = null
        let threw = null
        try { d = fn(cb) } catch (e) { threw = String((e && e.message) || e) }
        window.__tsDispose = typeof d === 'function' ? d : null
        return JSON.stringify({ returned: typeof d === 'function', threw: threw, real: real !== null })
      }
      window.__tsDisposeNow = function () {
        let threw = null
        try { if (typeof window.__tsDispose === 'function') window.__tsDispose() } catch (e) { threw = String((e && e.message) || e) }
        window.__tsDispose = null
        return JSON.stringify({ threw: threw })
      }
      return true
    })()`,
  )
  return { status, detail }
}

/** 页面内：标题相关快照（属性 / 几何 / FAB / 标题簇内可交互元素数）。 */
export const SNAP = `(() => {
  const SES = '[data-slot="conversation.session.header"]'
  const attrs = (el) => el === null ? null : Object.fromEntries(Array.from(el.attributes).map((a) => [a.name, a.value]))
  const rect = (el) => { if (el === null) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) } }
  const cluster = document.querySelector(SES + ' [class*="_titleCluster"]')
  const title = document.querySelector(SES + ' [class*="_crumbCurrent"]:not([class*="_crumbSubagent"])')
    || document.querySelector(SES + ' [class*="_crumbCurrent"]')
  const fab = document.querySelector('[data-meow-smooth-fab]')
  return JSON.stringify({
    vw: window.innerWidth,
    titleFound: title !== null,
    titleTag: title === null ? null : title.tagName,
    titleAttrs: attrs(title),
    titleRect: rect(title),
    titleTabIndex: title === null ? null : title.tabIndex,
    titleRole: title === null ? null : title.getAttribute('role'),
    // 可聚焦入口 = tabIndex>=0 **且** 具备 button 语义（tag=button 或 role=button）
    titleFocusable: title !== null && title.tabIndex >= 0
      && (title.tagName === 'BUTTON' || title.getAttribute('role') === 'button'),
    // 56px 让位看 **crumb 的 computed padding**（不看 header.x）
    crumbPaddingLeft: title === null ? null : getComputedStyle(title).paddingLeft,
    crumbPaddingInlineStart: title === null ? null : getComputedStyle(title).paddingInlineStart,
    rowPaddingLeft: (() => { const r = document.querySelector(SES + ' [class*="_titleRow"]'); return r === null ? null : getComputedStyle(r).paddingLeft })(),
    // 56px 让位挂在 _crumbs 上（模块用 padding-inline-start:0 取消），必须测它本身
    crumbsPaddingInlineStart: (() => { const c = document.querySelector(SES + ' [class*="_crumbs"]'); return c === null ? null : getComputedStyle(c).paddingInlineStart })(),
    crumbsPaddingLeft: (() => { const c = document.querySelector(SES + ' [class*="_crumbs"]'); return c === null ? null : getComputedStyle(c).paddingLeft })(),
    headerPaddingLeft: (() => { const h = document.querySelector('[data-slot="conversation.header"] > header'); return h === null ? null : getComputedStyle(h).paddingLeft })(),
    // 标题旁的真实可见图标：真实渲染出来的伪元素盒子（含标题自身 ::before）/ 可见 svg·img / background-image
    glyphBesideTitle: (() => {
      if (title === null) return null
      const pseudoGlyph = (el) => {
        for (const ps of ['::before', '::after']) {
          const cs = getComputedStyle(el, ps)
          if (cs.content === 'none' || cs.content === 'normal') continue
          const w = Number.parseFloat(cs.width)
          const h = Number.parseFloat(cs.height)
          if (!(w >= 4 && h >= 4)) continue
          const hasPaint = cs.backgroundImage !== 'none'
            || (cs.content !== '' && cs.content !== '\"\"' && cs.content !== \"''\" && cs.content !== 'normal')
          if (hasPaint) return { why: 'pseudo' + ps, w: +w.toFixed(1), h: +h.toFixed(1), paint: cs.backgroundImage !== 'none' ? 'background-image' : 'content', on: el === title ? 'title' : 'node' }
        }
        return null
      }
      const own = pseudoGlyph(title)
      if (own !== null) return own
      const tr = title.getBoundingClientRect()
      const cluster = document.querySelector(SES + ' [class*="_titleCluster"]') || document
      for (const el of Array.from(cluster.querySelectorAll('*'))) {
        const r = el.getBoundingClientRect()
        if (r.width < 4 || r.height < 4) continue
        const sameRow = Math.abs((r.y + r.height / 2) - (tr.y + tr.height / 2)) <= Math.max(8, tr.height / 2)
        if (!sameRow || r.x < tr.right - 4) continue
        const p = pseudoGlyph(el)
        if (p !== null) return p
        const g = el.querySelector('svg, img')
        if (g !== null) { const gr = g.getBoundingClientRect(); if (gr.width >= 4 && gr.height >= 4) return { why: 'svg-img', w: +gr.width.toFixed(1), h: +gr.height.toFixed(1), on: 'node' } }
        if (getComputedStyle(el).backgroundImage !== 'none') return { why: 'bg-image', w: +r.width.toFixed(1), h: +r.height.toFixed(1), on: 'node' }
      }
      return null
    })(),
    titleClusterRect: rect(cluster),
    clusterInteractive: cluster === null ? 0 : cluster.querySelectorAll('button, [role="button"], a, [tabindex]').length,
    rowRect: rect(document.querySelector(SES + ' [class*="_titleRow"]')),
    headerRect: rect(document.querySelector('[data-slot="conversation.header"] > header')),
    fabFound: fab !== null,
    fabRect: rect(fab),
    fabDisplay: fab === null ? null : getComputedStyle(fab).display,
    fabVisible: fab !== null && fab.getBoundingClientRect().width > 0 && getComputedStyle(fab).display !== 'none',
    rootAttrs: attrs(document.documentElement),
  })
})()`

/** 页面内：触发标题交互（click / 聚焦后 keydown）。 */
export const TRIGGER = `(function (kind, key) {
  const SES = '[data-slot="conversation.session.header"]'
  const title = document.querySelector(SES + ' [class*="_crumbCurrent"]:not([class*="_crumbSubagent"])')
    || document.querySelector(SES + ' [class*="_crumbCurrent"]')
  if (title === null) return JSON.stringify({ dispatched: false, reason: 'no-title' })
  if (kind === 'click') {
    title.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return JSON.stringify({ dispatched: true, calls: window.__tsCalls })
  }
  if (typeof title.focus === 'function') title.focus()
  const target = document.activeElement !== null ? document.activeElement : title
  const code = key === ' ' ? 'Space' : key
  target.dispatchEvent(new KeyboardEvent('keydown', { key: key, code: code, bubbles: true, cancelable: true }))
  // Space / Enter 均按"完整一次按键"发：keydown + keyup（实现只能算一次回调）
  target.dispatchEvent(new KeyboardEvent('keyup', { key: key, code: code, bubbles: true, cancelable: true }))
  return JSON.stringify({ dispatched: true, calls: window.__tsCalls, focused: document.activeElement === title })
})`

/** 页面内：给祖先面包屑按钮挂计数监听（capture），再点它。 */
export const ANCESTOR_ARM = `(() => {
  const b = document.querySelector('[data-slot="conversation.session.header"] button[class*="_crumb"]')
  if (b === null) return JSON.stringify({ found: false })
  window.__tsAncestor = b
  window.__tsAncestorHits = 0
  b.addEventListener('click', () => { window.__tsAncestorHits++ }, { capture: true })
  return JSON.stringify({ found: true, label: (b.textContent || '').trim().slice(0, 20) })
})()`

export const ANCESTOR_CLICK = `(() => {
  const b = window.__tsAncestor
  if (b === undefined || b === null) return JSON.stringify({ found: false })
  b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  return JSON.stringify({ found: true, ancestorHits: window.__tsAncestorHits, calls: window.__tsCalls })
})()`

/** 页面内：设置/清除 IME 标记（插件在 documentElement 上打 data-meow-smooth-ime）。 */
export function setIme(on) {
  return `(() => {
    if (${on}) document.documentElement.setAttribute('data-meow-smooth-ime', 'true')
    else document.documentElement.removeAttribute('data-meow-smooth-ime')
    return true
  })()`
}

/** 读当前 callback 计数。 */
export const READ_CALLS = `window.__tsCalls`

// ---- 隔离用：在真实 crumbs 里合成"祖先面包屑"与 lineage 控件（不触发任何真实导航）----

export const INJECT_SYNTH = `(() => {
  const SES = '[data-slot="conversation.session.header"]'
  const crumbs = document.querySelector(SES + ' [class*="_crumbs"]')
  if (crumbs === null) return JSON.stringify({ ok: false, reason: 'no-crumbs' })
  window.__tsAncestorHits = 0
  window.__tsLineageHits = 0
  const ancestor = document.createElement('button')
  ancestor.type = 'button'
  ancestor.className = 'synth_crumb'
  ancestor.textContent = 'SYNTH_ANCESTOR'
  ancestor.addEventListener('click', () => { window.__tsAncestorHits++ }, { capture: true })
  const lineage = document.createElement('span')
  lineage.setAttribute('data-slot', 'conversation.session.header.lineage')
  const lineageBtn = document.createElement('button')
  lineageBtn.type = 'button'
  lineageBtn.textContent = 'SYNTH_LINEAGE'
  lineageBtn.addEventListener('click', () => { window.__tsLineageHits++ }, { capture: true })
  lineage.appendChild(lineageBtn)
  crumbs.insertBefore(lineage, crumbs.firstChild)
  crumbs.insertBefore(ancestor, crumbs.firstChild)
  window.__tsSynth = { ancestor: ancestor, lineage: lineage }
  return JSON.stringify({ ok: true })
})()`

export const CLICK_SYNTH = `(() => {
  if (window.__tsSynth === undefined) return JSON.stringify({ ok: false })
  const callsBefore = window.__tsCalls
  window.__tsSynth.ancestor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  window.__tsSynth.lineage.querySelector('button').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  return JSON.stringify({
    ok: true,
    ancestorHits: window.__tsAncestorHits,
    lineageHits: window.__tsLineageHits,
    titleCallsDelta: window.__tsCalls - callsBefore,
  })
})()`

export const REMOVE_SYNTH = `(() => {
  if (window.__tsSynth !== undefined) {
    try { window.__tsSynth.ancestor.remove(); window.__tsSynth.lineage.remove() } catch (e) {}
    window.__tsSynth = undefined
  }
  return true
})()`

/** 把"当前标题"换成已可交互的 <button>（同样类名）→ 用来测"非普通 span 标题"的 fallback。 */
export const MAKE_TITLE_INTERACTIVE = `(() => {
  const SES = '[data-slot="conversation.session.header"]'
  const t = document.querySelector(SES + ' [class*="_crumbCurrent"]')
  if (t === null) return JSON.stringify({ ok: false })
  const b = document.createElement('button')
  b.type = 'button'
  b.className = t.className
  b.textContent = t.textContent
  window.__tsTitleBackup = t
  t.replaceWith(b)
  return JSON.stringify({ ok: true, tag: b.tagName, tabIndex: b.tabIndex })
})()`

export const RESTORE_TITLE = `(() => {
  const b = window.__tsTitleBackup
  if (b === undefined || b === null) return JSON.stringify({ ok: false })
  const live = document.querySelector('[data-slot="conversation.session.header"] [class*="_crumbCurrent"]')
  if (live !== null && live.tagName === 'BUTTON') live.replaceWith(b)
  window.__tsTitleBackup = null
  return JSON.stringify({ ok: true })
})()`

/** 页面内操作集：装载一次，供契约各项断言使用（全部按 live DOM 锚点，不绑实现内部）。 */
export const OPS = `
globalThis.__tsTitle = function () {
  const all = Array.from(document.querySelectorAll('[data-slot="conversation.session.header"] [class*="_crumbCurrent"]'))
  if (all.length === 0) return null
  const plain = all.find(function (e) { return String(e.className).indexOf('_crumbSubagent') === -1 })
  return plain || all[0]
}
globalThis.__tsState = function () {
  const t = globalThis.__tsTitle()
  const fab = document.querySelector('[data-meow-smooth-fab]')
  const cs = t === null ? null : getComputedStyle(t)
  const ps = t === null ? null : getComputedStyle(t, '::before')
  return JSON.stringify({
    marker: document.documentElement.hasAttribute('data-meow-smooth-title-entry'),
    titleFound: t !== null,
    role: t === null ? null : t.getAttribute('role'),
    tabindex: t === null ? null : t.getAttribute('tabindex'),
    ariaLabel: t === null ? null : t.getAttribute('aria-label'),
    text: t === null ? null : (t.textContent || '').trim().slice(0, 24),
    pseudoContent: ps === null ? null : ps.content,
    pseudoW: ps === null ? null : ps.width,
    display: cs === null ? null : cs.display,
    fabVisible: fab !== null && fab.getBoundingClientRect().width > 0 && getComputedStyle(fab).display !== 'none',
  })
}
globalThis.__tsSetExternalAttrs = function () {
  const t = globalThis.__tsTitle(); if (t === null) return JSON.stringify({ ok: false })
  t.setAttribute('role', 'link'); t.setAttribute('tabindex', '-1'); t.setAttribute('aria-label', '外部标签')
  return JSON.stringify({ ok: true })
}
globalThis.__tsSetRole = function (v) {
  const t = globalThis.__tsTitle(); if (t === null) return JSON.stringify({ ok: false })
  t.setAttribute('role', v); return JSON.stringify({ ok: true })
}
globalThis.__tsSetText = function (v) {
  const t = globalThis.__tsTitle(); if (t === null) return JSON.stringify({ ok: false })
  t.textContent = v; return JSON.stringify({ ok: true })
}
globalThis.__tsInsertCurrent = function () {
  const crumbs = document.querySelector('[data-slot="conversation.session.header"] [class*="_crumbs"]')
  if (crumbs === null) return JSON.stringify({ ok: false })
  const y = document.createElement('span')
  y.className = 'synth_crumbCurrent'
  y.textContent = 'SYNTH_CURRENT'
  crumbs.appendChild(y)
  window.__tsSynthCurrent = y
  return JSON.stringify({ ok: true, cls: y.className })
}
globalThis.__tsRemoveCurrent = function () {
  if (window.__tsSynthCurrent) { window.__tsSynthCurrent.remove(); window.__tsSynthCurrent = null }
  return true
}
globalThis.__tsPseudoOf = function (selector) {
  const el = document.querySelector(selector)
  if (el === null) return JSON.stringify({ found: false })
  const cs = getComputedStyle(el, '::before')
  return JSON.stringify({ found: true, content: cs.content, w: cs.width, h: cs.height })
}
globalThis.__tsAddSubagent = function () {
  const t = globalThis.__tsTitle(); if (t === null) return JSON.stringify({ ok: false })
  t.classList.add('synth_crumbSubagent')
  return JSON.stringify({ ok: true, cls: t.className })
}
globalThis.__tsRemoveSubagent = function () {
  const t = Array.from(document.querySelectorAll('[class*="synth_crumbSubagent"]'))
  for (const e of t) e.classList.remove('synth_crumbSubagent')
  return true
}
globalThis.__tsSetDisplay = function (v) {
  const t = globalThis.__tsTitle(); if (t === null) return JSON.stringify({ ok: false })
  t.style.display = v; return JSON.stringify({ ok: true })
}
globalThis.__tsReplaceHeader = function () {
  const h = document.querySelector('[data-slot="conversation.header"] > header')
  if (h === null) return JSON.stringify({ ok: false })
  const clone = h.cloneNode(true)
  // 模拟 React 新挂载而不是复制插件运行期属性；cloneNode 不复制事件监听器。
  for (const title of clone.querySelectorAll('[data-meow-smooth-title-claimed]')) {
    for (const attr of ['role', 'tabindex', 'aria-label', 'data-meow-smooth-title-claimed']) title.removeAttribute(attr)
  }
  h.replaceWith(clone)
  return JSON.stringify({ ok: true, titles: clone.querySelectorAll('[class*="_crumbCurrent"]').length })
}
globalThis.__tsSpaceRepeat = function () {
  const t = globalThis.__tsTitle(); if (t === null) return JSON.stringify({ ok: false })
  if (typeof t.focus === 'function') t.focus()
  const target = document.activeElement !== null ? document.activeElement : t
  const mk = function (rep) { return new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true, repeat: rep }) }
  const e1 = mk(false); target.dispatchEvent(e1)
  const e2 = mk(true); target.dispatchEvent(e2)
  return JSON.stringify({ ok: true, firstPrevented: e1.defaultPrevented, secondPrevented: e2.defaultPrevented, calls: window.__tsCalls })
}
`

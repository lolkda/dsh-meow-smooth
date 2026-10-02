/**
 * 隔离 fixture：在**自己的**隔离 browser context 标签里跑真实 GUI（同源、真实
 * CSS/DOM、真实排版引擎），绝不触碰用户已有标签。
 *
 * 取态：cookie 只从默认上下文**复制**给隔离上下文（登录墙），改的只是我们的标签。
 */

import { openTestTab, setViewport, sleep, tapSelector } from './cdp.mjs'
import { measure, measureWith } from './geometry.mjs'

/** 打开一个真实 GUI 测试标签并等应用挂载。 */
export async function openGuiTab(cdp, { baseUrl, width = 390, height = 844, dsf = 3 }) {
  const tab = await openTestTab(cdp, { url: baseUrl, width, height, dsf, mobile: true })
  const booted = await cdp.waitFor(tab.sessionId, `document.querySelector('[data-slot="root"] > *') !== null`, { timeoutMs: 30000 })
  if (booted !== true) return { tab, booted: false }
  // 等客户端插件（meow-smooth）也装上：它的样式表是插件注入行为的探针。
  const pluginUp = await cdp.waitFor(tab.sessionId, `document.querySelectorAll('style[data-plugin]').length > 0`, { timeoutMs: 15000 })
  return { tab, booted: true, pluginUp: pluginUp === true }
}

/**
 * 保证 header 是**非空会话**（hero/blank 态下 titleRow 是空的，几何断言无意义）。
 * 在本标签内点侧栏最长的那个会话行（只影响本标签的客户端状态）。
 */
export async function ensureNonEmptySession(cdp, sessionId) {
  const state = () => cdp.evaluate(
    sessionId,
    `JSON.stringify({
      crumbs: document.querySelectorAll('[data-slot="conversation.session.header"] [class*="_crumbs"]').length,
      actions: document.querySelectorAll('[data-slot="conversation.session.header"] [class*="_headerActions"]').length,
      tabs: document.querySelectorAll('[data-conversation-tabs]').length,
    })`,
  ).then(JSON.parse)
  const before = await state()
  if (before.crumbs > 0 && before.actions > 0 && before.tabs > 0) return { ok: true, clicked: false }

  // 会话列表只在宽视口渲染（窄屏侧栏收起，行不在 DOM 里）→ 先放宽再点。
  await setViewport(cdp, sessionId, { width: 1280, height: 900, dsf: 1, mobile: false })
  const rows = await cdp.evaluate(
    sessionId,
    `JSON.stringify(Array.from(document.querySelectorAll('[data-slot="sidebar"] [data-row-key^="session:"]')).map((r) => ({
      key: r.getAttribute('data-row-key'), text: (r.textContent || '').trim().slice(0, 80),
    })))`,
  ).then(JSON.parse)
  // 空白新会话（hero 态）没有 titleRow/actions，先排除；其余按标题长度降序（长标题更压排版）。
  const candidates = rows.filter((r) => r.text !== '').sort((a, b) => b.text.length - a.text.length)
  const tried = []
  for (const row of candidates) {
    await cdp.evaluate(
      sessionId,
      `(() => {
        const el = document.querySelector('[data-slot="sidebar"] [data-row-key="${row.key}"]')
        if (el === null) return JSON.stringify({ ok: false })
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        return JSON.stringify({ ok: true })
      })()`,
    )
    const ok = await cdp.waitFor(
      sessionId,
      `(document.querySelectorAll('[data-slot="conversation.session.header"] [class*="_crumbs"]').length > 0
        && document.querySelectorAll('[data-slot="conversation.session.header"] [class*="_headerActions"]').length > 0)`,
      { timeoutMs: 8000 },
    )
    tried.push({ key: row.key, ok: ok === true })
    if (ok === true) {
      await sleep(900)
      const after = await state()
      return { ok: after.tabs > 0, clicked: true, rows: rows.length, used: row.key, title: row.text, tried }
    }
  }
  return { ok: false, clicked: false, rows: rows.length, tried }
}

/** 当前会话标题（面包屑当前段）。 */
export async function currentTitle(cdp, sessionId) {
  return cdp.evaluate(sessionId, `(document.querySelector('[data-slot="conversation.session.header"] [class*="_crumbCurrent"]') || {}).textContent || ''`)
}

/** 长标题压测：把当前段文本换成 60 字，测完立刻还原（单次 evaluate 内完成）。 */
export function measureWithLongTitle(cdp, sessionId) {
  return measureWith(cdp, sessionId, {
    prelude: `
      const el = document.querySelector('[data-slot="conversation.session.header"] [class*="_crumbCurrent"]')
      window.__titleBackup = el === null ? null : el.textContent
      if (el !== null) el.textContent = '超长会话标题压测：'.repeat(6)
    `,
    cleanup: `
      const el2 = document.querySelector('[data-slot="conversation.session.header"] [class*="_crumbCurrent"]')
      if (el2 !== null && window.__titleBackup !== null) el2.textContent = window.__titleBackup
    `,
  })
}

/** furl 首行让位：打开 furl 标记后测同一套首行断言（测完摘掉标记）。 */
export function measureWithFurl(cdp, sessionId) {
  return measureWith(cdp, sessionId, {
    prelude: `document.documentElement.setAttribute('data-meow-smooth-furled', 'true')`,
    cleanup: `document.documentElement.removeAttribute('data-meow-smooth-furled')`,
  })
}

/** 打开"更多"菜单 → 返回菜单几何；调用方负责关。 */
export async function openMoreMenu(cdp, sessionId) {
  return cdp.evaluate(
    sessionId,
    `(() => {
      const utilities = document.querySelector('[data-slot="conversation.session.header"] [class*="_headerUtilities"]')
      const btn = utilities === null ? null : utilities.querySelector('button[aria-haspopup="menu"]')
      if (btn === null) return JSON.stringify({ ok: false, reason: 'no-more-button' })
      btn.click()
      return JSON.stringify({ ok: true })
    })()`,
  ).then(JSON.parse)
}

/** 菜单几何（真实 rect + 命中 + 是否越界）。 */
export async function menuGeometry(cdp, sessionId) {
  return cdp.evaluate(
    sessionId,
    `(() => {
      const menus = Array.from(document.querySelectorAll('[role="menu"]')).filter((m) => m.getBoundingClientRect().width > 0)
      const m = menus.length > 0 ? menus[menus.length - 1] : null
      if (m === null) return JSON.stringify({ visible: false })
      const r = m.getBoundingClientRect()
      const items = Array.from(m.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]'))
      const hit = (el) => {
        const b = el.getBoundingClientRect()
        if (b.width < 1 || b.height < 1) return false
        const e = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
        return e !== null && (e === el || el.contains(e))
      }
      return JSON.stringify({
        visible: true,
        rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1) },
        vw: window.innerWidth, vh: window.innerHeight,
        items: items.length,
        itemsHit: items.filter(hit).length,
      })
    })()`,
  ).then(JSON.parse)
}

/**
 * 菜单**每一项**的几何（不只是容器）：用于判"菜单项是否被顶栏规则误伤"。
 * 每项带稳定标识（role + 文本前若干字），保证安装前后比的是同一批项。
 */
export async function menuItemGeometry(cdp, sessionId) {
  return cdp.evaluate(
    sessionId,
    `(() => {
      const menus = Array.from(document.querySelectorAll('[role="menu"]')).filter((m) => m.getBoundingClientRect().width > 0)
      const m = menus.length > 0 ? menus[menus.length - 1] : null
      if (m === null) return JSON.stringify({ visible: false, items: [] })
      const r = m.getBoundingClientRect()
      const items = Array.from(m.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')).map((el, i) => {
        const b = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        return {
          i,
          role: el.getAttribute('role'),
          label: (el.textContent || '').trim().slice(0, 20),
          y: +b.y.toFixed(1), h: +b.height.toFixed(1), w: +b.width.toFixed(1),
          minHeight: cs.minHeight,
          padTop: cs.paddingTop, padBottom: cs.paddingBottom,
        }
      })
      return JSON.stringify({
        visible: true,
        container: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
        items,
      })
    })()`,
  ).then(JSON.parse)
}

/** 关闭"更多"菜单（Esc + 点按钮兜底），返回清理后的属性状态。 */
export async function closeMoreMenu(cdp, sessionId) {
  await cdp.evaluate(
    sessionId,
    `(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      const btn = document.querySelector('[data-slot="conversation.session.header"] [class*="_headerUtilities"] button[aria-haspopup="menu"]')
      if (btn !== null && btn.getAttribute('aria-expanded') === 'true') btn.click()
      return true
    })()`,
  )
  await sleep(400)
  return cdp.evaluate(
    sessionId,
    `JSON.stringify({
      menuCount: document.querySelectorAll('[role="menu"]').length,
      menuOpenAttr: document.querySelector('[data-slot="conversation.session.header"] > [class*="_titleRow"]')?.getAttribute('data-meow-smooth-menu-open') ?? null,
    })`,
  ).then((s) => ({ sessionId, ...JSON.parse(s) }))
}

/** 在指定视口下测量（含视口自检）。 */
export async function measureAt(cdp, sessionId, { width, height, dsf = 3 }) {
  const applied = await setViewport(cdp, sessionId, { width, height, dsf, mobile: true })
  const check = await cdp.evaluate(
    sessionId,
    `JSON.stringify({ innerW: window.innerWidth, innerH: window.innerHeight, narrow: window.matchMedia('(max-width:767.98px)').matches })`,
  ).then(JSON.parse)
  return { ...(await measure(cdp, sessionId)), viewport: { ...applied, ...check, ok: Math.abs(check.innerW - width) <= 1 } }
}

// ---- 安全网 / 压测工具 ----

/** 装全局错误收集（页面内真实报错/未处理拒绝都会被记下）。 */
export async function startErrorWatch(cdp, sessionId) {
  return cdp.evaluate(
    sessionId,
    `(() => {
      if (window.__meowTestErrors === undefined) {
        window.__meowTestErrors = []
        window.addEventListener('error', (e) => window.__meowTestErrors.push(String(e.message)))
        window.addEventListener('unhandledrejection', (e) => window.__meowTestErrors.push('unhandledrejection: ' + String(e.reason)))
      }
      return true
    })()`,
  )
}

export async function readErrors(cdp, sessionId) {
  return cdp.evaluate(sessionId, `JSON.stringify(window.__meowTestErrors || [])`).then(JSON.parse)
}

/** 长附加名压测：把四类附加项的标签文本加长（只动文本，不动结构）。 */
export function measureWithLongLabels(cdp, sessionId) {
  return measureWith(cdp, sessionId, {
    prelude: `
      window.__labelBackup = []
      const slot = document.querySelector('[data-slot="conversation.session.header.actions"]')
      for (const el of Array.from(slot ? slot.children : [])) {
        const span = el.querySelector('span[title], [class*="_triggerLabel"], button > span')
        if (span === null) continue
        window.__labelBackup.push([span, span.textContent])
        span.textContent = (span.textContent || '标签').slice(0, 6) + '超长附加项名称'.repeat(4)
      }
    `,
    cleanup: `
      for (const [el, text] of (window.__labelBackup || [])) { try { el.textContent = text } catch (e) {} }
    `,
  })
}

/** 动态 DOM 条目增删：摘掉最后一个附加项，测几何，再原位放回。 */
export function measureAfterEntryRemoved(cdp, sessionId) {
  return measureWith(cdp, sessionId, {
    prelude: `
      const slot = document.querySelector('[data-slot="conversation.session.header.actions"]')
      window.__removedEntry = null
      if (slot !== null && slot.children.length > 0) {
        window.__removedEntry = slot.lastElementChild
        window.__removedEntry.remove()
      }
    `,
    cleanup: `
      const slot2 = document.querySelector('[data-slot="conversation.session.header.actions"]')
      if (window.__removedEntry !== null && slot2 !== null) slot2.appendChild(window.__removedEntry)
    `,
  })
}

/** 不识别结构：把会话头 slot 锚改名（模块必须安全退回，不得报错或弄坏布局）。 */
export function measureWithRenamedSlot(cdp, sessionId) {
  return measureWith(cdp, sessionId, {
    prelude: `
      const anchor = document.querySelector('[data-slot="conversation.session.header"]')
      if (anchor !== null) anchor.setAttribute('data-slot', 'conversation.session.header.RENAMED')
    `,
    cleanup: `
      const anchor2 = document.querySelector('[data-slot="conversation.session.header.RENAMED"]')
      if (anchor2 !== null) anchor2.setAttribute('data-slot', 'conversation.session.header')
    `,
  })
}

/** 真实点按：更多按钮中心。 */
export async function tapMoreButton(cdp, sessionId) {
  return tapSelector(cdp, sessionId, '[data-slot="conversation.session.header"] [class*="_headerUtilities"] button[aria-haspopup="menu"]')
}

/** 真实点按：左下角 FAB（插件手势入口）。 */
export async function tapFab(cdp, sessionId) {
  return tapSelector(cdp, sessionId, '[data-meow-smooth-fab]')
}

/** FAB 当前是否可见可点（隐藏时点不到，不能拿它做"真实交互"证据）。 */
export async function fabState(cdp, sessionId) {
  return cdp.evaluate(
    sessionId,
    `(() => {
      const fab = document.querySelector('[data-meow-smooth-fab]')
      if (fab === null) return JSON.stringify({ present: false, visible: false })
      const r = fab.getBoundingClientRect()
      const cs = getComputedStyle(fab)
      return JSON.stringify({
        present: true, visible: r.width > 0 && r.height > 0 && cs.display !== 'none',
        rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
      })
    })()`,
  ).then(JSON.parse)
}

/** 该点是否落在 sidebar 展开态（用于确认"已还原"）。 */
export async function sidebarExpanded(cdp, sessionId) {
  return cdp.evaluate(
    sessionId,
    `(() => {
      const frame = document.querySelector('[data-slot="root"] > *')
      return JSON.stringify({
        collapsed: frame === null ? null : frame.getAttribute('data-sidebar-collapsed'),
        furled: document.documentElement.getAttribute('data-meow-smooth-furled'),
      })
    })()`,
  ).then(JSON.parse)
}

/** 晚挂载证明第 1 步：把会话头 slot 整个摘下来（父/位置记在 window 上）。 */
export async function detachSessionSlot(cdp, sessionId) {
  return cdp.evaluate(
    sessionId,
    `(() => {
      const node = document.querySelector('[data-slot="conversation.session.header"]')
      if (node === null) return JSON.stringify({ ok: false })
      window.__meowDetached = { node: node, parent: node.parentNode, next: node.nextSibling }
      node.remove()
      return JSON.stringify({ ok: true })
    })()`,
  ).then(JSON.parse)
}

/** 晚挂载证明第 2 步：原位放回（不重新 install，样式表一直在场）。 */
export async function reattachSessionSlot(cdp, sessionId) {
  return cdp.evaluate(
    sessionId,
    `(() => {
      const d = window.__meowDetached
      if (d === undefined || d === null) return JSON.stringify({ ok: false })
      d.parent.insertBefore(d.node, d.next)
      window.__meowDetached = null
      return JSON.stringify({ ok: true, crumbs: document.querySelectorAll('[data-slot="conversation.session.header"] [class*="_crumbs"]').length })
    })()`,
  ).then(JSON.parse)
}

/** 当前 furl 标记。 */
export async function furlState(cdp, sessionId) {
  return cdp.evaluate(sessionId, `document.documentElement.getAttribute('data-meow-smooth-furled')`)
}

/** 切到空态会话（hero/blank：没有 titleRow 内容），返回是否成功。 */
export async function openBlankSession(cdp, sessionId) {
  await setViewport(cdp, sessionId, { width: 1280, height: 900, dsf: 1, mobile: false })
  const clicked = await cdp.evaluate(
    sessionId,
    `(() => {
      const rows = Array.from(document.querySelectorAll('[data-slot="sidebar"] [data-row-key^="session:"]'))
      const blank = rows.find((r) => (r.textContent || '').trim().startsWith('新会话'))
      if (blank === undefined) return null
      blank.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      blank.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      blank.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return blank.getAttribute('data-row-key')
    })()`,
  )
  if (clicked === null) return { ok: false }
  await sleep(1500)
  const blank = await cdp.evaluate(sessionId, `document.querySelector('[data-slot="conversation.header"] > header').className.includes('headerBlank')`)
  return { ok: blank === true, key: clicked }
}

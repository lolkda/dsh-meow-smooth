/**
 * 顶部几何测量（页面内真实排版结果，不读 CSS 文本、不做 DOM 模拟）。
 *
 * 锚点全部取自 header-layout 在运行中 dsh 0.2.0-rc.2 上的 live DOM 实测：
 *  - `[data-slot="conversation.session.header"] > header` 命中 **0**（`<header>`
 *    是该 slot 锚点的父级）→ 旧插件选择器全系死规则；本模块一律用下面这套。
 *  - 类尾缀锚必须限定在 header 之下：未限定的 `[class*="_headerActions"]`
 *    全页命中 2 个（侧栏内还有一个），actions 子树匹配还会命中展开菜单里的
 *    元素（实测 `span[title]` 7 个、`button[aria-expanded]:not([aria-haspopup])` 4 个）。
 */

export const HDR = '[data-slot="conversation.header"] > header'
export const SES = '[data-slot="conversation.session.header"]'

/** 页面内测量脚本：返回 JSON 字符串（CDP Runtime.evaluate 取回）。 */
export const PAGE_MEASURE = `(() => {
  const HDR = '[data-slot="conversation.header"] > header'
  const SES = '[data-slot="conversation.session.header"]'
  const one = (s, r) => (r || document).querySelector(s)
  const hit = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return e !== null && (e === el || el.contains(e))
  }
  const box = (el) => {
    if (el === null || el === undefined) return null
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return {
      x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
      right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1),
      display: cs.display, visibility: cs.visibility, overflowX: cs.overflowX,
      scrollW: el.scrollWidth, clientW: el.clientWidth, fontSize: cs.fontSize,
      hit: cs.display === 'none' ? false : hit(el),
      text: (el.textContent || '').trim().slice(0, 60),
    }
  }
  const header = one(HDR)
  const titleRow = one(SES + ' > [class*="_titleRow"]')
  const crumbs = one(SES + ' [class*="_crumbs"]')
  const title = one(SES + ' [class*="_crumbCurrent"]')
  const utilities = one(SES + ' [class*="_headerUtilities"]')
  const corner = one(SES + ' [data-conversation-header-corner]')
  const tabs = one(HDR + ' [data-conversation-tabs][role="tablist"]')
  const actionsSlot = one(SES + ' [data-slot="conversation.session.header.actions"]')

  const kindOf = (el) => {
    if (el.matches('[data-team-action]') || el.querySelector('[data-team-action]') !== null) return 'team'
    if (el.querySelector('button[aria-haspopup="tree"]') !== null) return 'subagent'
    if (el.matches('span[title]') || el.querySelector('span[title]') !== null) return 'preset'
    if (el.querySelector('button[aria-expanded]:not([aria-haspopup])') !== null) return 'jobs'
    return 'other'
  }
  const labelOf = (el, kind) => {
    if (kind === 'preset') return el.matches('span[title]') ? el : el.querySelector('span[title]')
    if (kind === 'team') return el.querySelector('[class*="_triggerLabel"]') || el.querySelector('button > span')
    if (kind === 'jobs') return el.querySelector('button[aria-expanded]:not([aria-haspopup]) > span')
    if (kind === 'subagent') return el.querySelector('button[aria-haspopup="tree"] > span:not(:first-child)')
    return null
  }
  const buttonOf = (el) => (el.matches('button, [role="button"]') ? el : (el.querySelector('button, [role="button"]') || el))
  const arrowOf = (el, kind) => {
    if (kind === 'jobs') return el.querySelector('button[aria-expanded]:not([aria-haspopup]) > svg:not([data-state])')
    if (kind === 'subagent') return el.querySelector('button[aria-haspopup="tree"] > svg:not([data-state])')
    return null
  }
  const firstSpanOf = (el, kind) => (kind === 'subagent' ? el.querySelector('button[aria-haspopup="tree"] > span:first-child') : null)
  const entries = actionsSlot === null ? [] : Array.from(actionsSlot.children).map((el) => {
    const kind = kindOf(el)
    const label = labelOf(el, kind)
    const arrow = arrowOf(el, kind)
    const button = buttonOf(el)
    const firstSpan = firstSpanOf(el, kind)
    return {
      kind,
      tag: el.tagName.toLowerCase(),
      box: box(el),
      btn: box(button),
      btnDotContent: button === null ? null : getComputedStyle(button, '::before').content,
      label: box(label),
      labelDotContent: label === null ? null : getComputedStyle(label, '::before').content,
      firstSpanDotContent: firstSpan === null ? null : getComputedStyle(firstSpan, '::before').content,
      arrow: box(arrow),
      arrowDotContent: arrow === null ? null : getComputedStyle(arrow, '::before').content,
    }
  })

  // 只查 header 内部这条链（titleRow → titleCluster → headerActions → actions 槽）：
  // 官方在更外层（root/centerCol/frame）本来就用 overflow:hidden 排版，那是基线不是插件行为。
  const chainOf = (n) => ({ tag: n.tagName.toLowerCase(), cls: String(n.className).slice(0, 40), overflowX: getComputedStyle(n).overflowX })
  const headerChain = [
    titleRow,
    one(SES + ' [class*="_titleCluster"]'),
    one(SES + ' [class*="_headerActions"]'),
    actionsSlot,
  ].filter((n) => n !== null).map(chainOf)
  // 诊断用：titleRow 到 body 的祖先链（含官方布局容器），不参与断言。
  const ancestors = []
  for (let n = titleRow === null ? null : titleRow.parentElement; n !== null && n !== document.body; n = n.parentElement) ancestors.push(chainOf(n))

  const root = document.documentElement
  const frame = one('[data-slot="root"] > *')
  return JSON.stringify({
    vw: window.innerWidth, vh: window.innerHeight,
    doc: { scrollW: root.scrollWidth, clientW: root.clientWidth, scrollH: root.scrollHeight, clientH: root.clientHeight },
    attrs: {
      furled: root.getAttribute('data-meow-smooth-furled'),
      ime: root.getAttribute('data-meow-smooth-ime'),
      menuOpen: titleRow === null ? null : titleRow.getAttribute('data-meow-smooth-menu-open'),
      sidebarCollapsed: frame === null ? null : frame.getAttribute('data-sidebar-collapsed'),
    },
    sheets: {
      foldCss: document.querySelectorAll('style[data-meow-fold-css]').length,
      pluginTags: document.querySelectorAll('style[data-plugin]').length,
      total: document.querySelectorAll('style').length,
    },
    header: box(header),
    titleRow: box(titleRow),
    row1: { crumbs: box(crumbs), utilities: box(utilities), corner: box(corner), title: box(title) },
    moreBtn: box(utilities === null ? null : utilities.querySelector('button[aria-haspopup="menu"]')),
    panelBtn: box(corner === null ? null : corner.querySelector('button[data-sidebar-right-expand]')),
    tabs: box(tabs),
    tabsCount: tabs === null ? 0 : tabs.querySelectorAll('button[role="tab"]').length,
    entries,
    titleRowChain: headerChain,
    titleRowAncestors: ancestors,
    menuCount: document.querySelectorAll('[role="menu"]').length,
  })
})()`

/** 在页面里跑一次测量，返回对象。 */
export async function measure(cdp, sessionId) {
  const raw = await cdp.evaluate(sessionId, PAGE_MEASURE)
  return JSON.parse(raw)
}

/**
 * 带前置变更的测量：prelude 在测量前执行，cleanup 在取到结果后立刻执行——全程
 * 压在同一个 Runtime.evaluate 里，避免 React 重渲染插进来改掉前置变更。
 */
export async function measureWith(cdp, sessionId, { prelude = '', cleanup = '' } = {}) {
  const raw = await cdp.evaluate(
    sessionId,
    `(() => {
      let out
      try {
        ${prelude}
        out = ${PAGE_MEASURE}
      } catch (e) {
        ${cleanup}
        throw e
      }
      ${cleanup}
      return out
    })()`,
  )
  return JSON.parse(raw)
}

/** 纵向是否同一行带（默认容差 2px，按 top 比较）。 */
export function sameRow(a, b, tol = 2) {
  if (a === null || b === null) return false
  return Math.abs(a.y - b.y) <= tol
}

/** 所有可见项按行带（top）分组，用于"tabs 是否独占末行"这类断言。 */
export function groupRows(items, tol = 2) {
  const visible = items.filter((i) => i.box !== null && i.box.display !== 'none' && i.box.w > 0.5 && i.box.h > 0.5)
  const rows = []
  for (const item of visible.slice().sort((a, b) => a.box.y - b.box.y)) {
    const row = rows.find((r) => Math.abs(r.top - item.box.y) <= tol)
    if (row === undefined) rows.push({ top: item.box.y, bottom: item.box.bottom, items: [item.name] })
    else {
      row.items.push(item.name)
      row.bottom = Math.max(row.bottom, item.box.bottom)
    }
  }
  return rows
}

/** 两个矩形是否相交（面积 > 0，容差 1px）。 */
export function overlaps(a, b, tol = 1) {
  if (a === null || b === null) return false
  return a.x + tol < b.right && b.x + tol < a.right && a.y + tol < b.bottom && b.y + tol < a.bottom
}

/** 矩形是否落在容器内（容差 1px）。 */
export function inside(inner, outer, tol = 1) {
  if (inner === null || outer === null) return false
  return inner.x >= outer.x - tol && inner.right <= outer.right + tol && inner.y >= outer.y - tol && inner.bottom <= outer.bottom + tol
}

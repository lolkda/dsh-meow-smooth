/**
 * 手机（<768）把当前会话和全局页面标题兼作侧栏入口：标题变成无图标的可聚焦按钮，
 * 原小方块 FAB 退场，header-mobile 给首行留的 56px 让位取消。
 *
 * 纯属性 + CSS，不搬移/复制任何 React 节点：
 *   - 只在**普通当前标题 span**（无既有 role/tabindex、不在 button/lineage 内、
 *     不是 subagent 标题、且实际渲染出来）上做认领；
 *   - 认领 = 元素自身挂 `data-meow-smooth-title-claimed` + role/tabindex/aria-label，
 *     元素级规则（44px / 焦点）只认这个"认领标记"，未被认领的同名
 *     `_crumbCurrent`（如 subagent）不会借页面级标记改变外观；
 *   - 只还自己写的值：还原/维持前都比对"当前值是否仍是我写的那一份"，外部
 *     （React/他人）改写过的原样留给他方，不对抗、不覆盖；
 *   - 仅无标题兜底按钮用 `::before` 画菜单图标，普通标题不加图标；
 *   - 页面级规则（藏 FAB / 取消 56px）挂在 documentElement 的
 *     `data-meow-smooth-title-entry` 上，仅在"真的认领了标题"时存在，且 FAB 规则
 *     额外排除 IME 态 —— 无标题 / 无 callback / 已隐藏 header 时 FAB 一律保留。
 *
 * 点击监听挂在标题元素自身（冒泡相）。既有侧栏点击收起是 document **capture**
 * 监听，先跑、随后冒泡里的本监听再把侧栏打开 —— 这正是要的顺序；若把本监听也
 * 挂到 capture，收起会紧跟着把它关回去。
 */

/** 生效断点：与 header-mobile 同档，严格 <768。 */
const MOBILE_MEDIA = '(width < 768px)'
const HEADER_SLOT = '[data-slot="conversation.header"]'
const SESSION = '[data-slot="conversation.session.header"]'
const LINEAGE_SLOT = '[data-slot="conversation.session.header.lineage"]'
const FAB_SELECTOR = '[data-meow-smooth-fab]'
const IME_ATTR = 'data-meow-smooth-ime'
/** 页面级生效标记（documentElement）：藏 FAB、取消 56px 让位用。 */
const MARKER_ATTR = 'data-meow-smooth-title-entry'
/** 认领标记（挂在被认领的标题元素自身上）：44px / 焦点规则只认它。 */
const CLAIM_ATTR = 'data-meow-smooth-title-claimed'
/** 本模块样式表标记。 */
const SHEET_ATTR = 'data-meow-title-sidebar-entry-css'
/** 触控高度（与 header-mobile 首行一致）。 */
const TOUCH_MIN_H = 44
/** 我在标题上接管的属性：还原前逐个比对，只还自己写的值。 */
const MANAGED_ATTRS = ['role', 'tabindex', 'aria-label', CLAIM_ATTR] as const

/** 仅认领已验证的三个全局页面主标题，不碰文件内容/会话 Markdown 的标题。 */
const GLOBAL_TITLE_LOOKUP = [
  '[data-slot="main"] > [data-plugin-panel] > header h1',
  '[data-slot="main"] > .dsh-fm > header h1',
  '[data-slot="main"] [class*="_pageHeading"] > h1',
].join(', ')

/** 结构门槛：conversation.header 槽里存在带当前标题的会话头（与 JS 侧的限定同源）。 */
const GATE = `${HEADER_SLOT}:has(> header ${SESSION} [class*="_crumbCurrent"])`
const CLAIMED_TITLE = `:is(${GATE} > header ${SESSION} [class*="_crumbCurrent"], ${GLOBAL_TITLE_LOOKUP})[${CLAIM_ATTR}]`
const CRUMBS = `${GATE} > header ${SESSION} [class*="_crumbs"]`
/** JS 查找用：不依赖 :has()，兼容性更好。 */
const TITLE_LOOKUP = `${HEADER_SLOT} > header ${SESSION} [class*="_crumbCurrent"]`
const HEADER_LOOKUP = `${HEADER_SLOT} > header`

const CSS = `
@media ${MOBILE_MEDIA} {
/* 标题变 44px 高的可点区；保留官方 nowrap + ellipsis 的省略行为。 */
${CLAIMED_TITLE} {
  min-height: ${TOUCH_MIN_H}px;
  line-height: ${TOUCH_MIN_H}px;
  padding-block: 0;
  border-radius: var(--dsw-radius-md, 8px);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
/* 只为无标题兜底按钮绘制菜单图标；标题本身不增加图标或空白占位。 */
${FAB_SELECTOR}::before {
  content: "";
  display: inline-block;
  vertical-align: middle;
  width: 16px;
  height: 14px;
  margin-right: 6px;
  background-image: linear-gradient(currentColor, currentColor), linear-gradient(currentColor, currentColor), linear-gradient(currentColor, currentColor);
  background-size: 100% 2px;
  background-position: 0 0, 0 6px, 0 12px;
  background-repeat: no-repeat;
  opacity: 0.85;
}
${CLAIMED_TITLE}:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, currentColor);
  outline-offset: 2px;
}
/* 无普通标题时复用原按钮及其打开行为，只压缩外观，不丢失入口。 */
${FAB_SELECTOR} {
  width: 44px;
  height: 44px !important;
  min-height: 44px;
  top: 8px;
  left: 8px;
  background: transparent;
  border: 0;
  border-radius: 8px;
  box-shadow: none;
}
${FAB_SELECTOR} > * { display: none; }
${FAB_SELECTOR}::before { margin: 0; }
/* 入口可用 → 取消 header-mobile 给首行留的 56px（FAB 已退场，无需让位）。 */
html[${MARKER_ATTR}] ${CRUMBS} { padding-inline-start: 0 !important; }
/* 入口可用 → 隐藏原 FAB。IME 等既有隐藏态不参与，避免额外让 FAB 失踪。 */
html[${MARKER_ATTR}]:not([${IME_ATTR}]) ${FAB_SELECTOR} { display: none !important; }
}
`

/** 当前实例的拆除函数（同一时间只允许一份）。 */
let activeDispose: (() => void) | null = null

/**
 * 安装"标题兼作侧栏入口"。
 *
 * @param openSidebar - 打开侧栏的回调（由集成方提供：setFurled(false) + 必要时 toggleSidebar）。
 *   缺失时本模块不装饰标题、保留 FAB fallback。
 * @returns 拆除函数：撤销装饰与监听、只还原自己写的属性、移除标记与样式表；重复调用无副作用。
 */
export function installTitleSidebarEntry(openSidebar?: (() => void) | undefined): () => void {
  if (typeof document === 'undefined' || document.head === null) return () => {}

  activeDispose?.()
  activeDispose = null

  const canOpen = typeof openSidebar === 'function'
  const media = window.matchMedia(MOBILE_MEDIA)

  const sheet = document.createElement('style')
  sheet.setAttribute(SHEET_ATTR, 'true')
  // 无主 <style> 会被模块加载器认领、插件热替换时连坐删除 —— 必须自带归属标。
  sheet.setAttribute('data-plugin', '@lolkda/meow-smooth')
  sheet.textContent = CSS
  document.head.appendChild(sheet)

  /** 当前被认领的标题元素。 */
  let decorated: HTMLElement | null = null
  /** 接管前的属性原值（还原用）。 */
  const saved = new Map<string, string | null>()
  /** 我写进去的值（null = 我删掉或没设过）；用于"只还自己写的值"。 */
  const written = new Map<string, string | null>()

  const open = (): void => {
    if (canOpen) openSidebar()
  }

  const onClick = (): void => { open() }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing || event.keyCode === 229) return
    const space = event.key === ' ' || event.key === 'Spacebar'
    if (event.key !== 'Enter' && !space) return
    // Space 默认滚动页面：长按产生的 repeat 事件同样要挡，故放在 repeat 早退之前。
    if (space) event.preventDefault()
    if (event.repeat) return
    open()
  }

  const titleTextOf = (el: HTMLElement): string => (el.textContent ?? '').trim()

  /** 结构上"是普通当前标题"才算可用入口：subagent 标题 / 已有交互语义 / 在 lineage
   *  或按钮内 → 不认领。注意"本模块已认领的那一个"要先放行：它身上的 role/tabindex
   *  是我写的，若按"已有交互"排除掉，sync 会在 认领→清除→再认领 之间自激。 */
  const findTitle = (): HTMLElement | null => {
    const el = document.querySelector(TITLE_LOOKUP) ?? document.querySelector(GLOBAL_TITLE_LOOKUP)
    if (!(el instanceof HTMLElement)) return null
    const globalTitle = el.matches(GLOBAL_TITLE_LOOKUP)
    if (el.tagName !== 'SPAN' && !globalTitle) return null
    if (el.getAttribute('aria-hidden') === 'true') return null
    if (el.matches('[class*="_crumbSubagent"]')) return null
    // "实际渲染出来"才叫 header 可用：被任何机制隐藏时退回 FAB。
    if (el.getClientRects().length === 0) return null
    if (el === decorated) return el
    // 自动化页面的 tabindex=-1 仅用于宿主程序化聚焦；清理时还原。
    if (el.hasAttribute('role') || (el.hasAttribute('tabindex') && !(globalTitle && el.getAttribute('tabindex') === '-1'))) return null
    if (el.closest('button, a, [role="button"]') !== null) return null
    if (el.closest(LINEAGE_SLOT) !== null) return null
    return el
  }

  /** 写入/刷新本模块拥有的属性，并记录"我写的值"。 */
  const applyManaged = (el: HTMLElement): void => {
    const text = titleTextOf(el)
    el.setAttribute('role', 'button')
    el.setAttribute('tabindex', '0')
    el.setAttribute(CLAIM_ATTR, 'true')
    written.set('role', 'button')
    written.set('tabindex', '0')
    written.set(CLAIM_ATTR, 'true')
    if (text === '') {
      el.removeAttribute('aria-label')
      written.set('aria-label', null)
    } else {
      el.setAttribute('aria-label', text)
      written.set('aria-label', text)
    }
  }

  const detach = (): void => {
    if (decorated === null) return
    const el = decorated
    el.removeEventListener('click', onClick)
    el.removeEventListener('keydown', onKeyDown)
    // 只还"当前值仍是我写的那一份"：被外部（React/他人）改写过的属性原样留给他方。
    for (const name of MANAGED_ATTRS) {
      if (el.getAttribute(name) !== written.get(name)) continue
      const previous = saved.get(name) ?? null
      if (previous === null) el.removeAttribute(name)
      else el.setAttribute(name, previous)
    }
    saved.clear()
    written.clear()
    decorated = null
  }

  /** 撤销认领与页面标记（幂等）。 */
  const clear = (): void => {
    detach()
    document.documentElement.removeAttribute(MARKER_ATTR)
  }

  /** 标记写入必须幂等：槽容器未挂载时观察的是 documentElement，重复写入会自激。 */
  const ensureMarker = (): void => {
    if (document.documentElement.getAttribute(MARKER_ATTR) !== 'true') {
      document.documentElement.setAttribute(MARKER_ATTR, 'true')
    }
  }

  const decorate = (el: HTMLElement): void => {
    for (const name of MANAGED_ATTRS) saved.set(name, el.getAttribute(name))
    applyManaged(el)
    el.addEventListener('click', onClick)
    el.addEventListener('keydown', onKeyDown)
    decorated = el
    ensureMarker()
  }

  const sync = (): void => {
    if (!canOpen || !media.matches) { clear(); return }
    const el = findTitle()
    if (el === null) { clear(); return }
    if (el === decorated) {
      // role/tabindex 不再是我写的那一份 → 已被外部接管：释放而不抢回。
      if (el.getAttribute('role') !== written.get('role')
        || el.getAttribute('tabindex') !== written.get('tabindex')) { clear(); return }
      // aria-label 跟随标题文本（仅当它仍是我写的那一份，不覆盖他人的值）。
      const text = titleTextOf(el)
      if (el.getAttribute('aria-label') === written.get('aria-label')
        && (written.get('aria-label') ?? '') !== text) applyManaged(el)
      ensureMarker()
      return
    }
    clear()
    decorate(el)
  }

  /** 观察根取 conversation.header 槽容器（而非 header 本身）：整棵 header 被 React
   *  换掉时仍在观察范围内；槽容器也一起被换掉时，回调里会发现根已脱离文档并重挂。 */
  const observeRoot = (): Element =>
    document.querySelector(HEADER_SLOT) ?? document.querySelector(HEADER_LOOKUP) ?? document.querySelector('[data-slot="main"]') ?? document.documentElement
  const OBSERVE_OPTS: MutationObserverInit = {
    childList: true,
    subtree: true,
    attributes: true,
    // style/hidden 也要看：可见性变化必须触发释放（仅"实际可用"才藏 FAB）。
    attributeFilter: ['class', 'style', 'hidden', ...MANAGED_ATTRS],
  }
  let observed: Element = observeRoot()
  const observer = new MutationObserver(() => {
    if (!observed.isConnected) {
      observer.disconnect()
      observed = observeRoot()
      observer.observe(observed, OBSERVE_OPTS)
    }
    sync()
  })
  observer.observe(observed, OBSERVE_OPTS)
  // 槽自身被移除不属于槽内部 mutation；从稳定祖先发现挂载根更替。
  // 流式正文更新不触发布局同步，只在观察根真的变更时重挂。
  const mountObserver = new MutationObserver(() => {
    const nextRoot = observeRoot()
    if (nextRoot === observed && observed.isConnected) return
    observer.disconnect()
    observed = nextRoot
    observer.observe(observed, OBSERVE_OPTS)
    sync()
  })
  mountObserver.observe(document.body ?? document.documentElement, { childList: true, subtree: true })

  const onMediaChange = (): void => { sync() }
  media.addEventListener('change', onMediaChange)

  sync()

  const dispose = (): void => {
    media.removeEventListener('change', onMediaChange)
    mountObserver.disconnect()
    observer.disconnect()
    clear()
    sheet.remove()
    if (activeDispose === dispose) activeDispose = null
  }
  activeDispose = dispose
  return dispose
}

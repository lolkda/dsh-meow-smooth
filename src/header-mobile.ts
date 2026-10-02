/**
 * 手机顶部多行适配：<768 时标题 / 更多 / 面板 固定在首行，附加项（团队 / 预设 /
 * 后台任务 / 子代理目录）以完整可读标签换行到后续行，tabs 独占末行。
 *
 * 纯 CSS，不移动任何 React 节点：`_titleCluster` 用 display:contents 拆平，布局交给
 * `_titleRow` 的网格。样式始终挂载，但每条规则都以结构门槛开头 —— 门槛用 `:has()`
 * 实时判定「conversation.header 槽里的 header 之下存在新结构会话头」，所以结构不匹配
 * （页面其他 header、旧版结构、header 尚未挂载）时选择器自然不命中，既不需要观察器，
 * 也不依赖任何时间窗；`:has()` 不被支持时整条规则失效，同样是安全降级。
 *
 * 不在标题行链（titleRow / titleCluster / headerActions / utilities / corner）上写
 * overflow：后台任务菜单与「更多」菜单是原位 absolute（offsetParent 是各自的
 * position:relative 容器），加 overflow 会把菜单裁掉。
 */

/** 生效断点：严格 <768（Range 语法，不用 767.98 之类的近似值）。 */
const MOBILE_MEDIA = '(width < 768px)'

const HEADER_SLOT = '[data-slot="conversation.header"]'
const SESSION = '[data-slot="conversation.session.header"]'
const ACTIONS_SLOT = '[data-slot="conversation.session.header.actions"]'

/** 结构门槛：新结构 = conversation.header 槽里、header 之下有会话头槽且其直接子级是 titleRow。 */
const GATE = `${HEADER_SLOT}:has(> header ${SESSION} > [class*="_titleRow"])`
/** 所有规则的公共前缀（同时消掉「误伤页面其他 header / 同名 slot」的可能）。 */
const SCOPE = `${GATE} > header ${SESSION}`
const TITLE_ROW = `${SCOPE} > [class*="_titleRow"]`
const CRUMBS = `${SCOPE} [class*="_crumbs"]`
const ACTIONS = `${SCOPE} [class*="_headerActions"]`
const UTILITIES = `${SCOPE} [class*="_headerUtilities"]`
const CORNER = `${TITLE_ROW} > [data-conversation-header-corner]`
/** 附加条目根（团队 / 预设 / 后台任务 / 子代理目录各一个）；只取直接子级，菜单内容不在此列。 */
const ENTRY_ROOTS = `${ACTIONS} > ${ACTIONS_SLOT} > *`
/** 预设 chip 本身就是条目根（不再有内层按钮）。 */
const ENTRY_PRESET = `${ACTIONS} > ${ACTIONS_SLOT} > span[title]`
/** 团队条目根带 data-team-action 标记。 */
const ENTRY_TEAM = `${ACTIONS} > ${ACTIONS_SLOT} > [data-team-action]`
/** 条目根的直接按钮（团队 / 后台任务 / 子代理目录）。 */
const ENTRY_BUTTONS = `${ENTRY_ROOTS} > button`

/** 本模块样式表标记：唯一识别 + 卸载时精确回收。 */
const SHEET_ATTR = 'data-meow-header-mobile-css'
/** 小方块（FAB）宽度：furl 时首行文字让开的距离。 */
const FAB_WIDTH = 56
const TOUCH_MIN_H = 44

const MOBILE_HEADER_CSS = `
@media ${MOBILE_MEDIA} {
/* 三行：首行 标题 + 更多 + 面板；第二行起附加项（tabs 由官方 grid-column:1/-1 独占末行）。 */
${TITLE_ROW} {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: stretch;
  column-gap: 8px;
  row-gap: 6px;
}
/* 拆平中间层：crumbs 与 actions 直接成为 titleRow 的网格项。 */
${SCOPE} [class*="_titleCluster"] { display: contents; }
${CRUMBS} { grid-area: 1 / 1 / 2 / 2; min-width: 0; }
${UTILITIES} { grid-area: 1 / 2 / 2 / 3; margin-left: 8px; }
${CORNER} { grid-area: 1 / 3 / 2 / 4; }
${ACTIONS} {
  grid-area: 2 / 1 / 3 / -1;
  flex-wrap: wrap;
  align-items: center;
  column-gap: 14px;
  row-gap: 6px;
}
/* furl：只让首行文字避开左上角小方块，后续行照旧用满宽度。 */
html[data-meow-smooth-furled] ${CRUMBS} { padding-inline-start: ${FAB_WIDTH}px; }
/* 首行「更多 / 面板」触控高度。 */
${UTILITIES} button[aria-haspopup="menu"],
${CORNER} button[data-sidebar-right-expand] { min-height: ${TOUCH_MIN_H}px; }
/* 附加条目：限定到条目根自身的直接按钮 / 标签，避免命中展开菜单里的同形元素。
   条目根与按钮都开收缩，超长名由下面的 nowrap + ellipsis 省略而不是撑破整行。 */
${ENTRY_ROOTS},
${ENTRY_BUTTONS} { min-width: 0; max-width: 100%; }
${ENTRY_BUTTONS} { min-height: ${TOUCH_MIN_H}px; }
${ENTRY_BUTTONS} > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 预设 chip：官方 @container(width<=540px) 隐藏，旧插件 <1024 又压成 0 字号 / 20px 宽，
   且旧 JS 展开态会写内联字号 —— 故这几项必须 !important。上限取 min(180px,100%)：
   保留官方 180px 截断，同时不允许超出条目行宽。 */
${ENTRY_PRESET} {
  display: inline-flex !important;
  font-size: 12px !important;
  max-width: min(180px, 100%) !important;
  min-height: ${TOUCH_MIN_H}px;
  align-items: center;
}
/* 团队 label：官方 @container(width<=480px) 隐藏。 */
${ENTRY_TEAM} > button > span { display: inline-flex !important; }
/* 后台任务：计数文字与箭头被旧插件 <1024 压缩规则隐藏。 */
${ENTRY_BUTTONS}[aria-expanded]:not([aria-haspopup]) > span,
${ENTRY_BUTTONS}[aria-expanded]:not([aria-haspopup]) > svg:not([data-state]) { display: inline-block !important; }
/* 子代理目录：标签与箭头同上（状态圆点在首个 span 内，保留）。 */
${ENTRY_BUTTONS}[aria-haspopup="tree"] > span:not(:first-child),
${ENTRY_BUTTONS}[aria-haspopup="tree"] > svg:not([data-state]) { display: inline-block !important; }
/* 旧插件的"灰点兜底"伪元素：这里文字与图标都回来了，留着会多一个假圆点。 */
${ENTRY_BUTTONS}[aria-expanded]:not([aria-haspopup])::before,
${ENTRY_BUTTONS}[aria-haspopup="tree"] > span:first-child::before { content: none !important; }
}
`

/** 当前实例的拆除函数（同一时间只允许一份，重复 install 先撤旧的）。 */
let currentDispose: (() => void) | null = null

/**
 * 安装手机顶部多行适配。重复调用先撤旧实例，不会叠加样式表。
 *
 * @returns 拆除函数：移除本模块样式表；重复调用无副作用。
 */
export function installMobileHeader(): () => void {
  if (typeof document === 'undefined' || document.head === null) return () => {}

  currentDispose?.()
  currentDispose = null

  const style = document.createElement('style')
  style.setAttribute(SHEET_ATTR, 'true')
  // 无主 <style> 会被模块加载器认领、插件热替换时连坐删除 —— 必须自带归属标。
  style.setAttribute('data-plugin', '@lolkda/meow-smooth')
  style.textContent = MOBILE_HEADER_CSS
  document.head.appendChild(style)

  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    style.remove()
    if (currentDispose === dispose) currentDispose = null
  }
  currentDispose = dispose
  return dispose
}

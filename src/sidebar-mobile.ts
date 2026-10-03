/** 手机侧栏独立页与窄屏导航收起：不复制节点或另建侧栏状态。 */
const FRAME = '[data-slot="root"] > [class*="_frame"]:has(> [class*="_sidebarCol"] > [data-slot="sidebar"])'
const OPEN = `${FRAME}:not([data-sidebar-collapsed])`
const CSS = `
@media (width < 768px) {
  /* 两页都保持整屏宽；会话移出视口，不再被压成细条。 */
  ${OPEN} { grid-template-columns: 100% 100% 0px !important; }
  ${OPEN} > [class*="_sidebarCol"] > [data-slot="sidebar"] > * { width: 100% !important; }
  ${OPEN} > [class*="_centerCol"] { visibility: hidden; }
  ${OPEN} > [data-side="sidebar"] { display: none; }
}
`

// 宿主 ui-sidebar / ui-workspace 的导航入口。新会话空白页可能没有
// session-scoped dock，不能只依赖 sessionId 变化；重复点击也应返回主内容。
// 工作区按钮与操作菜单共用 iconButton 样式，只按宿主中英文 aria-label
// 识别创建动作，不能把整条 workspace 行或所有行内按钮当作导航。
const NAVIGATION_TARGETS = [
  '[data-row-key^="session:"]',
  'nav[class*="_panelList"] > button',
  'button[aria-label="新建会话"]',
  'button[aria-label="New session"]',
  '[data-row-key^="workspace:"] button[aria-label^="在“"][aria-label$="”中新建会话"]',
  '[data-row-key^="workspace:"] button[aria-label^="New session in "]',
].map(selector => `[data-slot="sidebar"] ${selector}`).join(', ')

export function installSidebarMobile(onNavigate: () => void): () => void {
  const style = document.createElement('style')
  style.setAttribute('data-meow-sidebar-mobile-css', 'true')
  style.setAttribute('data-plugin', '@lolkda/meow-smooth')
  style.textContent = CSS
  document.head.appendChild(style)
  // 导航收起与原生 SIDEBAR_AUTO_COLLAPSE 一致；独立页布局仍只作用于 <768px。
  const media = window.matchMedia('(width < 1024px)')
  let disposed = false
  let navigateTimer: number | undefined
  const onClick = (event: MouseEvent): void => {
    if (!media.matches || event.button !== 0 || !(event.target instanceof Element)) return
    const row = event.target.closest(NAVIGATION_TARGETS)
    if (!row) return
    const control = event.target.closest('button, input, [contenteditable="true"], [aria-haspopup]')
    if (control && control !== row) return
    // 捕获阶段兼容工作区按钮的 stopPropagation；下一任务再收起，确保宿主
    // click 先执行（可信事件的监听器之间也可能运行 microtask）。
    window.clearTimeout(navigateTimer)
    navigateTimer = window.setTimeout(() => {
      navigateTimer = undefined
      if (!disposed && media.matches) onNavigate()
    }, 0)
  }
  document.addEventListener('click', onClick, true)
  return () => {
    disposed = true
    window.clearTimeout(navigateTimer)
    document.removeEventListener('click', onClick, true)
    style.remove()
  }
}

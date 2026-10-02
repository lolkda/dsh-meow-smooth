/** 手机侧栏独立页：只改变布局，不复制节点或另建侧栏状态。 */
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

export function installSidebarMobile(onNavigate: () => void): () => void {
  const style = document.createElement('style')
  style.setAttribute('data-meow-sidebar-mobile-css', 'true')
  style.setAttribute('data-plugin', '@lolkda/meow-smooth')
  style.textContent = CSS
  document.head.appendChild(style)
  const media = window.matchMedia('(width < 768px)')
  let disposed = false
  const onClick = (event: MouseEvent): void => {
    if (!media.matches || event.button !== 0 || !(event.target instanceof Element)) return
    const row = event.target.closest('[data-slot="sidebar"] [data-row-key^="session:"], [data-slot="sidebar"] nav[class*="_panelList"] > button')
    if (!row) return
    const control = event.target.closest('button, input, [contenteditable="true"], [aria-haspopup]')
    if (control && control !== row) return
    // 会话行和全局面板入口都返回主内容，包括再次点击当前页面。
    // 放到宿主选择处理之后，不拦截或替代原生选会话行为。
    queueMicrotask(() => { if (!disposed && media.matches) onNavigate() })
  }
  document.addEventListener('click', onClick, true)
  return () => {
    disposed = true
    document.removeEventListener('click', onClick, true)
    style.remove()
  }
}

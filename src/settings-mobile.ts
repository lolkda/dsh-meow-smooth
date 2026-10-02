/** 手机设置单页导航：目录 → 分类内容 → 返回目录。宿主仍负责配置和关闭。 */
const ATTR = 'data-meow-smooth-settings'
const BACK = 'data-meow-settings-back'
const PANEL = 'div[role="dialog"][data-shortcut-modal="settings"]'
const CSS = `
[${BACK}] { display: none; }
@media (width < 768px) {
  ${PANEL}[${ATTR}] {
    position: fixed;
    inset: 0;
    display: block;
    width: 100% !important;
    height: 100% !important;
    max-width: none !important;
    max-height: none !important;
    border-radius: 0 !important;
    box-shadow: none !important;
  }
  ${PANEL}[${ATTR}] > nav {
    width: 100%; height: 100%; box-sizing: border-box; padding: 22px 16px 0;
    border-right: 0;
  }
  ${PANEL}[${ATTR}] > nav button { min-height: 44px; }
  ${PANEL}[${ATTR}] > [class*="_content"] { width: 100%; height: 100%; min-width: 0; }
  ${PANEL}[${ATTR}="detail"] > nav { display: none; }
  /* 目录态仍复用右上角原生关闭按钮，其余内容不参与点击或无障碍导航。 */
  ${PANEL}[${ATTR}="menu"] > [class*="_content"] {
    position: absolute; inset: 0; pointer-events: none;
  }
  ${PANEL}[${ATTR}="menu"] > [class*="_content"] > [class*="_options"],
  ${PANEL}[${ATTR}="menu"] > [class*="_content"] > [class*="_header"] > [class*="_actions"] { visibility: hidden; }
  ${PANEL}[${ATTR}] > [class*="_content"] > [class*="_header"] {
    padding-left: 16px; padding-right: 12px; min-height: 54px;
  }
  ${PANEL}[${ATTR}] button[class*="_close"] { pointer-events: auto; min-width: 44px; min-height: 44px; }
  ${PANEL}[${ATTR}="detail"] [${BACK}] {
    display: inline-flex; align-items: center; flex-shrink: 0;
    min-height: 44px; padding: 0 8px; border: 0; border-radius: 8px;
    background: transparent; color: inherit; font: inherit; cursor: pointer;
  }
  ${PANEL}[${ATTR}="detail"] [${BACK}]:focus-visible { outline: 2px solid currentColor; }
}
`

let activeDispose: (() => void) | null = null

/** 不搬移 React 节点：仅注入返回按钮和面板状态属性，卸载时全部回收。 */
export function installSettingsMobile(): () => void {
  activeDispose?.()
  const sheet = document.createElement('style')
  sheet.setAttribute('data-meow-settings-css', 'true')
  sheet.setAttribute('data-plugin', '@lolkda/meow-smooth')
  sheet.textContent = CSS
  document.head.appendChild(sheet)
  const media = window.matchMedia('(width < 768px)')
  let panel: HTMLElement | null = null
  let back: HTMLButtonElement | null = null
  let lastCategory: HTMLButtonElement | null = null
  let disposed = false

  const releasePanel = (): void => {
    panel?.removeAttribute(ATTR)
    back?.remove()
    back = null
    lastCategory = null
  }
  const ensureBack = (): void => {
    if (back?.isConnected) return
    const header = panel?.querySelector(':scope > [class*="_content"] > [class*="_header"]')
    if (!header) return
    back = document.createElement('button')
    back.type = 'button'
    back.setAttribute(BACK, 'true')
    back.setAttribute('aria-label', '返回设置目录')
    back.textContent = '‹ 返回设置'
    header.prepend(back)
  }
  const applyMode = (): void => {
    if (!panel) return
    if (media.matches) {
      ensureBack()
      panel.setAttribute(ATTR, 'menu')
    } else {
      panel.removeAttribute(ATTR)
    }
  }
  const syncPanel = (): void => {
    const next = document.querySelector<HTMLElement>(`${PANEL}:has(> nav)`)
    if (next !== panel) {
      releasePanel()
      panel = next
      applyMode()
    } else if (panel && media.matches) {
      ensureBack()
    }
  }
  const onClick = (event: MouseEvent): void => {
    if (!panel || !media.matches || !(event.target instanceof Element)) return
    const button = event.target.closest('button')
    if (!button || !panel.contains(button)) return
    if (button === back) {
      panel.setAttribute(ATTR, 'menu')
      const focus = lastCategory?.isConnected ? lastCategory : panel.querySelector<HTMLButtonElement>('nav [aria-current="true"]')
      focus?.focus({ preventScroll: true })
    } else if (panel.querySelector(':scope > nav')?.contains(button)) {
      // document 冒泡阶段已让宿主 onSelect 处理，同一分类也能重新进入内容页。
      lastCategory = button
      panel.setAttribute(ATTR, 'detail')
      queueMicrotask(() => { if (!disposed && media.matches && panel?.getAttribute(ATTR) === 'detail') back?.focus({ preventScroll: true }) })
    }
  }
  const observer = new MutationObserver(syncPanel)
  observer.observe(document.body, { childList: true, subtree: true })
  document.addEventListener('click', onClick)
  media.addEventListener('change', applyMode)
  syncPanel()
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    observer.disconnect()
    document.removeEventListener('click', onClick)
    media.removeEventListener('change', applyMode)
    releasePanel()
    panel = null
    sheet.remove()
    if (activeDispose === dispose) activeDispose = null
  }
  activeDispose = dispose
  return dispose
}

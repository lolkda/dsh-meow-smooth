import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const nextTask = () => new Promise(resolve => setTimeout(resolve, 0))

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../../src/sidebar-mobile.ts', import.meta.url))],
  bundle: true, write: false, format: 'iife', globalName: 'sidebarMobile',
})

// Mirror the host ui-sidebar/ui-workspace DOM contracts (including hashed CSS
// module names and both built-in locales). No real sessions or workspaces are created.
function fixture(t, width = 390) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>
    <div data-slot="sidebar"><div>
      <button id="brand" class="abc_brand" aria-label="新建会话"><span>DSH</span></button>
      <button id="toggle" aria-label="收起侧边栏">Toggle</button>
      <button id="new" class="abc_newSession" aria-label="新建会话"><span>新会话</span><svg><path /></svg></button>
      <div data-row-key="workspace:example" role="treeitem" aria-expanded="true">
        <span id="workspace-title">example</span><span class="def_rowActions">
          <button id="workspace-menu" aria-label="example 的操作"><svg><path /></svg></button>
          <button id="workspace-new" aria-label="在“example”中新建会话"><svg><path /></svg></button>
        </span>
      </div>
      <div data-row-key="workspace:english" role="treeitem">
        <button id="workspace-new-en" aria-label="New session in english"><span>+</span></button>
      </div>
      <div id="session" data-row-key="session:current" role="treeitem">
        <span id="session-title">Current session</span>
        <button id="session-menu" aria-haspopup="menu">More</button>
        <input id="rename"><span id="editable" contenteditable="true">Rename</span>
      </div>
      <nav class="abc_panelList"><button id="files"><span>Files</span></button></nav>
      <button id="settings" aria-label="设置">Settings</button>
      <button id="add-workspace" aria-label="添加工作区">Add workspace</button>
    </div></div>
    <div role="menu"><button id="menu-action" role="menuitem">Rename</button></div>
    <button id="outside" class="abc_newSession" aria-label="新建会话">Outside</button>
    <div data-row-key="workspace:outside"><button id="outside-workspace" aria-label="New session in outside">Outside</button></div>
  </body></html>`, { runScripts: 'outside-only' })
  const { window } = dom
  window.matchMedia = query => ({ get matches() { return width < Number(query.match(/<\s*(\d+)px/)[1]) } })
  window.eval(outputFiles[0].text + '\nwindow.sidebarMobile = sidebarMobile;')
  const calls = []
  const dispose = window.sidebarMobile.installSidebarMobile(() => calls.push('collapse'))
  t.after(() => { dispose(); window.close() })
  const click = (selector, options = {}) => {
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...options })
    window.document.querySelector(selector).dispatchEvent(event)
    return event
  }
  return { window, calls, dispose, click, resize(value) { width = value } }
}

for (const selector of ['#new', '#new span', '#new path', '#brand span', '#workspace-new path', '#workspace-new-en span', '#session-title', '#files span']) {
  test(`${selector}: returns to main content after native navigation`, async t => {
    const f = fixture(t)
    f.window.document.querySelector(selector).addEventListener('click', event => {
      f.calls.push('native')
      // Workspace action buttons stop propagation in the host.
      event.stopPropagation()
    })
    const event = f.click(selector)
    assert.deepEqual(f.calls, ['native'], 'must not collapse before native click handling')
    assert.equal(event.defaultPrevented, false)
    await Promise.resolve()
    assert.deepEqual(f.calls, ['native'], 'must wait for the next task, not a capture-phase microtask')
    await nextTask()
    assert.deepEqual(f.calls, ['native', 'collapse'])
  })
}

test('English ordinary new-session button is supported', async t => {
  const f = fixture(t)
  f.window.document.querySelector('#new').setAttribute('aria-label', 'New session')
  f.click('#new')
  await nextTask()
  assert.deepEqual(f.calls, ['collapse'])
})

test('new session closes again even when already on the blank page (no sessionId change)', async t => {
  const f = fixture(t)
  for (let i = 0; i < 2; i++) {
    f.click('#new span')
    await nextTask()
  }
  assert.deepEqual(f.calls, ['collapse', 'collapse'])
})

for (const width of [320, 767, 768, 1023, 1024, 1280]) {
  for (const selector of ['#new', '#workspace-new']) {
    test(`${selector}: narrow-screen auto-collapse boundary at ${width}px`, async t => {
      const f = fixture(t, width)
      f.click(selector)
      await nextTask()
      assert.equal(f.calls.length, width < 1024 ? 1 : 0)
    })
  }
}

for (const selector of ['#workspace-title', '#workspace-menu path', '#session-menu', '#rename', '#editable', '#toggle', '#settings', '#add-workspace', '#menu-action', '#outside', '#outside-workspace']) {
  test(`${selector}: does not dismiss the sidebar`, async t => {
    const f = fixture(t)
    f.click(selector)
    await nextTask()
    assert.deepEqual(f.calls, [])
  })
}

test('non-primary clicks do not dismiss the sidebar', async t => {
  const f = fixture(t)
  f.click('#new', { button: 1 })
  f.click('#workspace-new', { button: 2 })
  await nextTask()
  assert.deepEqual(f.calls, [])
})

test('disposing cancels pending navigation and removes listeners and styles', async t => {
  const f = fixture(t)
  f.click('#new')
  f.dispose()
  await nextTask()
  f.click('#workspace-new')
  f.click('#session-title')
  await nextTask()
  assert.deepEqual(f.calls, [])
  assert.equal(f.window.document.querySelector('[data-meow-sidebar-mobile-css]'), null)
})

test('resizing to desktop before deferred dismissal leaves sidebar unchanged', async t => {
  const f = fixture(t)
  f.click('#new')
  f.resize(1024)
  await nextTask()
  assert.deepEqual(f.calls, [])
})

/**
 * 集成层：把**真实构建产物** lib/client.js 装进隔离浏览器标签，用 ModuleLoader stub
 * 捕获 factory，再用最小 ctx 执行**真实 apply**，验证 header 模块确实被接进插件生命周期。
 *
 * 契约（Lead 定）：
 *  - 不 mock header 模块本身；被测的是"client.ts 有没有把它接进 apply + disposer"。
 *  - react/react-jsx-runtime 只提供最小导出（不渲染组件）：所有槽位注册回调都不会被执行。
 *  - 只断言两件事：header 模块的样式表被安装；其 disposer 能把它移除。
 *  另外提供一个**对照**：插件自己的 fold 样式表必须被装上（证明 apply 真跑到底、
 *  ctx stub 足够），否则说明是 harness 不足，不能当成功能 RED。
 */

/**
 * 页面内：捕获 bundle 的工厂。
 *
 * 不去改写 `window.__ModuleLoader__`（真页面上它是加载器自有对象，可能不可写/不可配置），
 * 改为由 Node 侧把 bundle 文本里的 `window.__ModuleLoader__.load(` 替换成
 * `globalThis.__meowCaptureLoad(`（见 captureBundleText），再在这里接住。
 */
export const RUN_BUNDLE = `
  globalThis.__meowCaptureLoad = function (def) {
    // load() 收到的是模块定义对象 { id, factory }，真正要执行的是 def.factory。
    globalThis.__meowCapturedId = def && def.id
    globalThis.__meowCaptured = def !== null && def !== undefined && typeof def.factory === 'function' ? def.factory : null
  }
  globalThis.__meowRunBundle = function (text) {
    globalThis.__meowCaptured = null
    try {
      new Function(text)()
    } catch (e) {
      return { factory: null, error: String((e && e.message) || e) }
    }
    return { factory: globalThis.__meowCaptured, error: null }
  }
`

/** Node 侧：把 bundle 的 ModuleLoader 调用改接到测试捕获点（不动页面全局）。 */
export function captureBundleText(text) {
  const patched = text.replace('window.__ModuleLoader__.load(', 'globalThis.__meowCaptureLoad(')
  if (patched === text) throw new Error('未能改写 bundle 的 __ModuleLoader__.load 调用——构建产物格式变了？')
  return patched
}

/** 页面内：最小 require（不渲染组件，任何 react API 都返回空实现）。 */
export const REACT_STUB = `
  globalThis.__meowRequire = function (id) {
    const empty = function () { return {} }
    const proxy = new Proxy(empty, {
      get: function (_t, k) {
        if (k === '__esModule') return true
        if (k === 'then') return undefined
        if (k === 'default') return proxy
        return empty
      },
      apply: function () { return {} },
      construct: function () { return {} },
    })
    return proxy
  }
`

/** 页面内：最小 ctx（任何未知服务都给"什么都能点"的代理，避免过度 mock 具体形状）。 */
export const CTX_STUB = `
  globalThis.__meowCtx = function () {
    const anyFn = function () { return undefined }
    const svc = function () {
      return new Proxy(anyFn, {
        get: function (_t, k) { return k === 'then' ? undefined : anyFn },
        apply: function () { return undefined },
      })
    }
    const injected = []
    const effects = []
    const ctx = {
      slots: {
        inject: function (name, cb) { injected.push(name); return function () {} },
        register: function () { return {} },
        registerAll: function () { return {} },
      },
      layout: { toggleSidebar: anyFn },
      effect: function (cb) { effects.push(cb); return function () {} },
      get: function () { return undefined },
      on: anyFn,
      inject: anyFn,
      sessions: svc(),
      conversation: svc(),
      webRuntime: svc(),
      connection: svc(),
    }
    return { ctx: ctx, injected: injected, effects: effects }
  }
`

/** 页面内：第一步——跑 bundle 捕获工厂（结果单独返回，便于定位）。 */
export const STEP_CAPTURE = `
  (function () {
    const r = globalThis.__meowRunBundle(globalThis.__meowBundleText)
    return JSON.stringify({
      factoryType: r.factory === null ? 'null' : typeof r.factory,
      captureError: r.error,
      textLen: (globalThis.__meowBundleText || '').length,
    })
  })()
`

/** 页面内：第二步——用最小 require 执行 factory，拿到模块导出面。 */
export const STEP_FACTORY = `
  (function () {
    if (typeof globalThis.__meowCaptured !== 'function') return JSON.stringify({ ok: false, reason: 'no-factory' })
    try {
      globalThis.__meowMod = globalThis.__meowCaptured(globalThis.__meowRequire)
      return JSON.stringify({ ok: true, exportsShape: Object.keys(globalThis.__meowMod || {}).sort(), applyType: typeof (globalThis.__meowMod || {}).apply })
    } catch (e) {
      return JSON.stringify({ ok: false, reason: 'factory-threw', error: String((e && e.message) || e) })
    }
  })()
`

/** 页面内：第三步——真实 apply（最小 ctx）。 */
export const STEP_APPLY = `
  (function () {
    const mod = globalThis.__meowMod
    if (mod === undefined || typeof mod.apply !== 'function') return JSON.stringify({ ok: false, reason: 'no-apply-export' })
    const built = globalThis.__meowCtx()
    globalThis.__meowInjected = built.injected
    globalThis.__meowEffects = built.effects
    let applyError = null
    try {
      mod.apply(built.ctx)
    } catch (e) {
      applyError = String((e && e.message) || e)
    }
    return JSON.stringify({
      ok: true,
      applyError: applyError,
      applyStage: document.documentElement.dataset.meowApplyStage || null,
      injectedCount: built.injected.length,
      effectsCount: built.effects.length,
      hasClientDispose: typeof window.__meowSmoothClientDispose === 'function',
      headerSheets: document.querySelectorAll('style[data-meow-header-mobile-css]').length,
      foldSheets: document.querySelectorAll('style[data-meow-fold-css]').length,
      pluginSheets: document.querySelectorAll('style[data-plugin="@lolkda/meow-smooth"]').length,
      errors: (window.__meowTestErrors || []).slice(0, 5),
    })
  })()
`

const COUNT_SNIPPET = `
  function __counts() {
    return {
      headerSheets: document.querySelectorAll('style[data-meow-header-mobile-css]').length,
      foldSheets: document.querySelectorAll('style[data-meow-fold-css]').length,
      pluginSheets: document.querySelectorAll('style[data-plugin="@lolkda/meow-smooth"]').length,
    }
  }
`

/** 页面内：**只**跑 ctx.effect 登记的拆除器 —— 验证"仅 ctx.effect 就能去掉 header 样式"。 */
export const RUN_DISPOSE_EFFECT_ONLY = `
  (function () {
    ${COUNT_SNIPPET}
    const before = __counts()
    const effects = (globalThis.__meowEffects || []).splice(0)
    let ran = 0
    let firstError = null
    for (const cb of effects) {
      try {
        const d = cb() // cordis 语义：effect 回调返回 disposer
        if (typeof d === 'function') { d(); ran++ }
        else firstError = firstError || 'effect 回调没返回 disposer'
      } catch (e) { firstError = firstError || String((e && e.message) || e) }
    }
    return JSON.stringify({ ran: ran, firstError: firstError, before: before, after: __counts() })
  })()
`

/** 页面内：再跑插件自带的 window 清理入口 —— 验证双清理幂等（不得抛错）。 */
export const RUN_DISPOSE_WINDOW = `
  (function () {
    ${COUNT_SNIPPET}
    const before = __counts()
    let threw = null
    try {
      if (typeof window.__meowSmoothClientDispose === 'function') window.__meowSmoothClientDispose()
    } catch (e) { threw = String((e && e.message) || e) }
    return JSON.stringify({ threw: threw, hadEntry: typeof window.__meowSmoothClientDispose === 'function', before: before, after: __counts() })
  })()
`

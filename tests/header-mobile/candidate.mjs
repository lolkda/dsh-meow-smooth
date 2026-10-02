/**
 * 候选模块加载：把 src/header-mobile.ts 用 esbuild 打成 IIFE，注入测试标签里执行
 * **真实** install。
 *
 * 契约（task-3 / Lead 定）：
 *  - 生产接口只有 `installMobileHeader(): () => void`，不导出任何布局结论 API。
 *  - 模块不存在时**不是 import 错误**：降级成 noop（`() => () => {}`），让断言
 *    以"行为不达"的方式失败（RED），而不是让测试崩掉。
 *  - 模块若带外部依赖（react 等）无法在页面里解析 → 同样降级 noop，并如实报出。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DEFAULT_ENTRY = fileURLToPath(new URL('../../src/header-mobile.ts', import.meta.url))
const GLOBAL_NAME = '__meowHeaderMobile'

/** 打成浏览器可执行的 IIFE 文本。 */
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
    for (const [spec, info] of Object.entries(out.imports ?? [])) {
      if (info.external === true) externals.add(spec)
    }
  }
  return { code: result.outputFiles[0].text, externals: [...externals] }
}

/**
 * 准备候选：加载 + 注入页面。
 * @returns {{status:'loaded'|'missing'|'external-deps'|'failed'|'esbuild-missing', detail?:string, externals?:string[], bytes?:number}}
 */
export async function prepareCandidate(cdp, sessionId, { entry = DEFAULT_ENTRY } = {}) {
  let bundled = null
  let status = 'loaded'
  let detail
  if (!existsSync(entry)) {
    status = 'missing'
    detail = `模块不存在：${entry}`
  } else {
    try {
      bundled = await bundle(entry)
    } catch (e) {
      if (String(e.message).includes('Cannot find package') && String(e.message).includes('esbuild')) {
        status = 'esbuild-missing'
      } else {
        status = 'failed'
      }
      detail = String(e.message).slice(0, 300)
    }
  }

  const usable = status === 'loaded' && bundled !== null && bundled.externals.length === 0
  if (status === 'loaded' && bundled.externals.length > 0) {
    status = 'external-deps'
    detail = `外部依赖无法在页面内解析：${bundled.externals.join(', ')}`
  }

  const code = usable ? bundled.code : ''
  await cdp.evaluate(
    sessionId,
    `(() => {
      ${code}
      const exported = (typeof ${GLOBAL_NAME} !== 'undefined' && ${GLOBAL_NAME} !== null) ? ${GLOBAL_NAME} : null
      const real = exported !== null && typeof exported.installMobileHeader === 'function' ? exported.installMobileHeader : null
      window.__meowCandidate = {
        status: ${JSON.stringify(status)},
        real: real !== null,
        install: real !== null ? real : function () { return function () {} },
        dispose: null,
      }
      return true
    })()`,
  )
  return { status, detail, externals: bundled?.externals ?? [], bytes: usable ? bundled.code.length : 0 }
}

/** 执行真实 install；返回 disposer 是否是函数（契约要求）。 */
export async function install(cdp, sessionId) {
  const raw = await cdp.evaluate(
    sessionId,
    `(() => {
      const c = window.__meowCandidate
      for (const fn of (window.__meowDisposers || [])) { try { fn() } catch (e) {} }
      window.__meowDisposers = []
      let d = null
      try { d = c.install() } catch (e) { return JSON.stringify({ ok: false, threw: String(e && e.message || e) }) }
      const isFn = typeof d === 'function'
      if (isFn) window.__meowDisposers.push(d)
      return JSON.stringify({ ok: true, returnedFunction: isFn })
    })()`,
  )
  return JSON.parse(raw)
}

/** 调用新模块自己的 disposer（不测整个插件的 dispose）。 */
export async function dispose(cdp, sessionId) {
  const raw = await cdp.evaluate(
    sessionId,
    `(() => {
      const list = window.__meowDisposers || []
      let n = 0
      for (const fn of list.splice(0)) { try { fn(); n++ } catch (e) {} }
      return JSON.stringify({ disposed: n })
    })()`,
  )
  return JSON.parse(raw)
}

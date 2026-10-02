/**
 * 极简 CDP 客户端（零 npm 依赖，Node ≥22 全局 WebSocket）。
 *
 * 用途：本机没有任何浏览器二进制（Edge 版旧脚本在 Linux 上首行即抛），唯一可用
 * 的真实引擎是外部 Chrome 的 CDP 端点（默认 http://127.0.0.1:9222）。
 *
 * 纪律（与任务契约一致）：
 *  - 只连给到的端点；连不上返回 null，由调用方判 ENV 失败，绝不自行拉起浏览器。
 *  - 测试标签一律建在**隔离 browser context** 里（cookie 从默认上下文复制认证
 *    cookie，见 copyAuthCookies），**绝不 attach 或改写用户已有标签**。
 */

const DEFAULT_ENDPOINT = process.env.MEOW_CDP ?? 'http://127.0.0.1:9222'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 连接 CDP 浏览器端点；不可达返回 null（调用方据此判 ENV，不抛错）。 */
export async function connect({ endpoint = DEFAULT_ENDPOINT } = {}) {
  let version
  try {
    version = await (await fetch(`${endpoint}/json/version`)).json()
  } catch {
    return null
  }
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  try {
    await new Promise((res, rej) => {
      ws.onopen = res
      ws.onerror = () => rej(new Error('websocket error'))
    })
  } catch {
    return null
  }

  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id === undefined) return
    const p = pending.get(msg.id)
    if (p === undefined) return
    pending.delete(msg.id)
    if (msg.error !== undefined) p.reject(new Error(`${msg.error.message} (${p.method})`))
    else p.resolve(msg.result)
  }

  function call(method, params = {}, sessionId) {
    const id = ++seq
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method })
      ws.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }))
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`CDP 超时: ${method}`))
        }
      }, 20000)
    })
  }

  /** 在目标里求值并取回 JSON（表达式自己 JSON.stringify）。 */
  async function evaluate(sessionId, expression) {
    const res = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    if (res.exceptionDetails !== undefined) {
      throw new Error(`页面异常: ${JSON.stringify(res.exceptionDetails).slice(0, 300)}`)
    }
    return res.result.value
  }

  /** 轮询表达式直到返回非 null（返回该值）；超时返回 null。 */
  async function waitFor(sessionId, expression, { timeoutMs = 20000, intervalMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const v = await evaluate(sessionId, expression)
        if (v !== null && v !== false) return v
      } catch {
        /* 页面尚未就绪，继续等 */
      }
      await sleep(intervalMs)
    }
    return null
  }

  return { call, evaluate, waitFor, endpoint, browser: version.Browser, close: () => { try { ws.close() } catch { /* ignore */ } } }
}

/**
 * 在隔离上下文中开一个测试标签并导航到 url。
 * 认证 cookie 从默认上下文复制（dsh web 的登录墙；隔离上下文自身没有 cookie，
 * 实测不带 cookie 只会拿到 "dsh web authentication required" 页）。
 */
export async function openTestTab(cdp, { url, width, height, dsf = 3, mobile = true, copyCookies = true }) {
  const { browserContextId } = await cdp.call('Target.createBrowserContext', { disposeOnDetach: false })
  const { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank', browserContextId })
  const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true })
  await cdp.call('Page.enable', {}, sessionId)
  await cdp.call('Runtime.enable', {}, sessionId)
  if (copyCookies) await copyAuthCookies(cdp, sessionId, url)
  await setViewport(cdp, sessionId, { width, height, dsf, mobile })
  await cdp.call('Page.navigate', { url }, sessionId)
  return {
    sessionId,
    targetId,
    browserContextId,
    close: async () => {
      try { await cdp.call('Target.disposeBrowserContext', { browserContextId }) } catch { /* ignore */ }
    },
  }
}

/** 把默认上下文里属于目标 origin 的 cookie 复制进隔离上下文（只读默认上下文，不改它）。 */
export async function copyAuthCookies(cdp, sessionId, url) {
  const host = new URL(url).hostname
  const { cookies } = await cdp.call('Storage.getCookies', {})
  const mine = cookies.filter((c) => c.domain.replace(/^\./, '') === host)
  for (const c of mine) {
    await cdp.call(
      'Network.setCookie',
      { name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite },
      sessionId,
    )
  }
  return mine.map((c) => `${c.name}@${c.domain}${c.path}`) // 只回名字，绝不回值
}

/** 设备度量覆盖（真实视口，不是 CSS 欺骗）。 */
export async function setViewport(cdp, sessionId, { width, height, dsf = 3, mobile = true }) {
  await cdp.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dsf, mobile }, sessionId)
  await cdp.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId)
  await cdp.call('Runtime.evaluate', {
    expression: `window.dispatchEvent(new Event('resize'))`,
    returnByValue: true,
  }, sessionId)
  await sleep(700)
  return { width, height }
}

/** 真实输入：在坐标处派发**可信**鼠标事件（走 Input 域，不是页面内 el.click()）。 */
export async function tap(cdp, sessionId, { x, y }) {
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }, sessionId)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, sessionId)
  await sleep(50)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, sessionId)
}

/**
 * 真实输入点按选择器命中的元素中心（可信事件）。
 * 顺带回传该坐标上真正被命中的元素——用于区分"点到了"与"被遮挡"。
 */
export async function tapSelector(cdp, sessionId, selector) {
  const raw = await cdp.evaluate(
    sessionId,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (el === null) return null
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return null
      const x = r.x + r.width / 2
      const y = r.y + r.height / 2
      const top = document.elementFromPoint(x, y)
      return JSON.stringify({
        x, y, w: r.width, h: r.height,
        occludedBy: top === null ? null : (top === el || el.contains(top) ? null : top.tagName.toLowerCase() + '[class=' + String(top.className).slice(0, 30) + ']'),
      })
    })()`,
  )
  if (raw === null) return { tapped: false }
  const info = JSON.parse(raw)
  await tap(cdp, sessionId, { x: info.x, y: info.y })
  return { tapped: true, ...info }
}

/** 自检：视口覆盖真的生效了吗（否则几何断言无意义）。 */
export async function viewportSelfCheck(cdp, sessionId, { width }) {
  return cdp.evaluate(
    sessionId,
    `JSON.stringify({ innerW: window.innerWidth, innerH: window.innerHeight,
        narrow: window.matchMedia('(max-width:767.98px)').matches })`,
  ).then((s) => {
    const v = JSON.parse(s)
    return { ...v, ok: Math.abs(v.innerW - width) <= 1 }
  })
}

export { sleep }

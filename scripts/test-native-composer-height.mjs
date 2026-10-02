#!/usr/bin/env node
/** Regression for the composer fold behavior in the current or installed bundle. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, openTestTab, setViewport, sleep, tap, tapSelector } from '../tests/header-mobile/cdp.mjs'
import { openGuiTab } from '../tests/header-mobile/fixture.mjs'
import { CTX_STUB, REACT_STUB, RUN_BUNDLE, STEP_APPLY, STEP_CAPTURE, STEP_FACTORY, captureBundleText } from '../tests/header-mobile/integration.mjs'
import { createFixtureExpression, fixtureSnapshotExpression, removeFixtureExpression, resetFixtureExpression } from '../tests/composer-height/fixture.mjs'

const BASE = process.env.MEOW_BASE ?? 'http://192.168.1.100:3080'
const ENDPOINT = process.env.MEOW_CDP ?? 'http://127.0.0.1:9222'
const INSTALLED = process.argv.includes('--installed')
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'artifacts/native-height-tests')
const checks = []
const log = []
const check = (name, ok, detail = '') => {
  checks.push({ name, status: ok ? 'PASS' : 'FAIL', detail })
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`
  log.push(line); console.log(line)
}
const skip = (name, detail = '') => {
  checks.push({ name, status: 'SKIP', detail })
  const line = `SKIP ${name}${detail ? ` — ${detail}` : ''}`
  log.push(line); console.log(line)
}
const totals = () => ({
  pass: checks.filter((x) => x.status === 'PASS').length,
  fail: checks.filter((x) => x.status === 'FAIL').length,
  skip: checks.filter((x) => x.status === 'SKIP').length,
})
const resultLine = () => {
  const t = totals()
  return `RESULT PASS=${t.pass} FAIL=${t.fail} SKIP=${t.skip} exit=${exitCode}`
}
const failEnv = (message) => { throw Object.assign(new Error(message), { envFailure: true }) }
let cdp = null
let tab = null
let exitCode = 3
let applyInfo = null

try {
  cdp = await connect({ endpoint: ENDPOINT })
  if (!cdp) failEnv(`CDP unavailable: ${ENDPOINT}`)
  const opened = await openGuiTab(cdp, { baseUrl: BASE, width: 1280, height: 900, dsf: 1 })
  tab = opened.tab
  if (!opened.booted || !opened.pluginUp) failEnv(`GUI/plugin unavailable: ${JSON.stringify({ booted: opened.booted, pluginUp: opened.pluginUp })}`)
  const sid = tab.sessionId
  await setViewport(cdp, sid, { width: 390, height: 844, dsf: 3, mobile: true })

  if (!INSTALLED) {
    const bundlePath = join(ROOT, 'lib/client.js')
    if (!existsSync(bundlePath)) failEnv(`missing real bundle: ${bundlePath}`)
    const patched = captureBundleText(readFileSync(bundlePath, 'utf8'))
    await cdp.evaluate(sid, `${RUN_BUNDLE}\n${REACT_STUB}\n${CTX_STUB}\nglobalThis.__meowBundleText=${JSON.stringify(patched)};true`)
    const capture = JSON.parse(await cdp.evaluate(sid, STEP_CAPTURE))
    const factory = JSON.parse(await cdp.evaluate(sid, STEP_FACTORY))
    if (capture.factoryType !== 'function' || !factory.ok || factory.applyType !== 'function') failEnv(`bundle harness failed: ${JSON.stringify({ capture, factory })}`)
    // Run the bundle's actual apply entrypoint; the isolated recipient never sends or submits.
    applyInfo = JSON.parse(await cdp.evaluate(sid, STEP_APPLY))
    if (applyInfo.applyError || !applyInfo.hasClientDispose || applyInfo.foldSheets < 1) failEnv(`real apply did not complete: ${JSON.stringify(applyInfo)}`)
  } else {
    applyInfo = await cdp.evaluate(sid, `JSON.stringify({foldSheets:document.querySelectorAll('style[data-meow-fold-css]').length,pluginSheets:document.querySelectorAll('style[data-plugin="meow-smooth"]').length})`).then(JSON.parse)
    if (applyInfo.pluginSheets < 1) failEnv('installed plugin stylesheet not present in GUI')
  }

  for (const kind of ['textarea', 'contenteditable']) {
    const created = JSON.parse(await cdp.evaluate(sid, createFixtureExpression(kind)))
    const { id } = created
    const ev = (expression) => cdp.evaluate(sid, expression)
    try {
      const initial = JSON.parse(await ev(fixtureSnapshotExpression(id)))
      check(`${kind}-long-draft-fixture`, initial.draftLength > 500 && initial.scrollTop > 0 && initial.unrelatedAttr === 'keep-me', JSON.stringify(initial))
      const inputSelector = `#${id} textarea, #${id} [data-composer-input]`
      const visibleTap = await ev(`(() => { const el=document.querySelector(${JSON.stringify(inputSelector)}); const r=el.getBoundingClientRect(); const s=el.closest('[data-input-scroll]').getBoundingClientRect(); const y=Math.max(r.top+2,Math.min(r.bottom-2,s.top+10)); const x=r.left+Math.min(20,r.width/2); const top=document.elementFromPoint(x,y); return JSON.stringify({x,y,hit:top===el||el.contains(top),top:top?.tagName}) })()`).then(JSON.parse)
      await tap(cdp, sid, { x: visibleTap.x, y: visibleTap.y })
      check(`${kind}-real-pointer-focus`, visibleTap.hit && await ev(`document.activeElement === document.querySelector(${JSON.stringify(inputSelector)})`) === true, JSON.stringify(visibleTap))
      await sleep(200)
      const focusState = JSON.parse(await ev(fixtureSnapshotExpression(id)))
      check(`${kind}-focus-keeps-native-height-and-marker`, focusState.foldAttr === null && focusState.foldHeight === '' && focusState.maxHeight === 'none' && Math.abs(focusState.height - initial.height) < 1,
        `before=${JSON.stringify(initial)} after=${JSON.stringify(focusState)}`)

      // A real click on another control within the card must not alter native sizing.
      const insideTap = await tapSelector(cdp, sid, `#${id} button`)
      await sleep(180)
      const cardClickState = JSON.parse(await ev(fixtureSnapshotExpression(id)))
      check(`${kind}-card-click-keeps-native-height`, insideTap.tapped && cardClickState.foldAttr === null && cardClickState.foldHeight === '' && cardClickState.maxHeight === 'none' && Math.abs(cardClickState.height - initial.height) < 1,
        `tap=${JSON.stringify(insideTap)} state=${JSON.stringify(cardClickState)}`)

      // Blur by focusing an isolated button, then exercise an actual outside click.
      await ev(`document.querySelector('[data-height-test-focus="${id}"]').focus();true`)
      await sleep(220)
      const blurState = JSON.parse(await ev(fixtureSnapshotExpression(id)))
      check(`${kind}-blur-keeps-native-height-and-scroll`, blurState.foldAttr === null && blurState.foldHeight === '' && blurState.maxHeight === 'none' && Math.abs(blurState.height - initial.height) < 1 && blurState.scrollTop === initial.scrollTop,
        `before=${JSON.stringify(initial)} after=${JSON.stringify(blurState)}`)
      await ev(resetFixtureExpression(id))
      await sleep(80)
      await tap(cdp, sid, { x: visibleTap.x, y: visibleTap.y })
      const outsideTap = await tapSelector(cdp, sid, `[data-height-test-outside="${id}"]`)
      await sleep(220)
      const outsideState = JSON.parse(await ev(fixtureSnapshotExpression(id)))
      check(`${kind}-outside-click-keeps-native-height-and-marker`, outsideTap.tapped && outsideState.foldAttr === null && outsideState.foldHeight === '' && outsideState.maxHeight === 'none' && Math.abs(outsideState.height - initial.height) < 1,
        `tap=${JSON.stringify(outsideTap)} before=${JSON.stringify(initial)} after=${JSON.stringify(outsideState)}`)

      // Test the legacy-marker cleanup contract when apply executes against an existing old installation.
      if (!INSTALLED) {
        const staleSeed = await ev(`(() => { const c=document.getElementById(${JSON.stringify(id)}); c.setAttribute('data-meow-smooth','collapsed'); c.style.setProperty('--meow-smooth-fold-height','31px'); c.setAttribute('data-height-test-unrelated','keep-me'); return true })()`)
        if (!staleSeed) failEnv('could not seed stale fold state')
        const again = JSON.parse(await ev(STEP_APPLY))
        if (again.applyError) failEnv(`second apply failed: ${JSON.stringify(again)}`)
        const staleState = JSON.parse(await ev(fixtureSnapshotExpression(id)))
        check(`${kind}-apply-clears-legacy-fold-state-only`, staleState.foldAttr === null && staleState.foldHeight === '' && staleState.unrelatedAttr === 'keep-me' && staleState.draftLength === initial.draftLength,
          JSON.stringify(staleState))
      } else {
        skip(`${kind}-apply-clears-legacy-fold-state-only`, 'installed mode does not rerun apply; bundle mode verifies migration cleanup')
      }

      await ev(resetFixtureExpression(id))
      for (const width of [390, 1280]) {
        await setViewport(cdp, sid, { width, height: 900, dsf: width < 768 ? 3 : 1, mobile: width < 768 })
        await sleep(180)
        const responsive = JSON.parse(await ev(fixtureSnapshotExpression(id)))
        check(`${kind}-breakpoint-${width}-keeps-native-height`, responsive.foldAttr === null && responsive.foldHeight === '' && responsive.maxHeight === 'none' && Math.abs(responsive.height - initial.height) < 1,
          JSON.stringify(responsive))
      }
    } finally {
      await cdp.evaluate(sid, removeFixtureExpression(id))
    }
  }
  exitCode = checks.some((x) => x.status === 'FAIL') ? 1 : 0
} catch (error) {
  check('environment-or-harness', false, String(error?.stack ?? error))
  exitCode = error?.envFailure ? 3 : 1
} finally {
  await tab?.close()
  cdp?.close()
  mkdirSync(OUT, { recursive: true })
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const result = { startedAt: new Date().toISOString(), baseUrl: BASE, cdpEndpoint: ENDPOINT, mode: INSTALLED ? 'installed' : 'bundle-apply', exitCode, applyInfo, totals: totals(), checks }
  const jsonPath = join(OUT, `native-composer-height-${stamp}.json`)
  const logPath = join(OUT, `native-composer-height-${stamp}.log`)
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`)
  writeFileSync(logPath, `${log.join('\n')}\n${resultLine()}\n`)
  console.log(`ARTIFACT ${jsonPath}`)
  console.log(`LOG ${logPath}`)
}
console.log(resultLine())
process.exitCode = exitCode

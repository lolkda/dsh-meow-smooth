#!/usr/bin/env node
/** Real GUI acceptance for full-screen sidebar, settings drill-down and slot removal. */
import { readFileSync } from 'node:fs'
import { connect, setViewport, sleep, tapSelector, tap } from '../tests/header-mobile/cdp.mjs'
import { openGuiTab, ensureNonEmptySession } from '../tests/header-mobile/fixture.mjs'
import { RUN_BUNDLE, REACT_STUB, CTX_STUB, STEP_CAPTURE, STEP_FACTORY, STEP_APPLY, RUN_DISPOSE_EFFECT_ONLY, RUN_DISPOSE_WINDOW, captureBundleText } from '../tests/header-mobile/integration.mjs'
const installed = process.argv.includes('--installed')
const checks = []
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log(`${ok?'PASS':'FAIL'} ${name}: ${JSON.stringify(detail)}`) }
const closeSelector = '[data-shortcut-modal="settings"] > [class*="_content"] > [class*="_header"] > button[class*="_close"]'
const c = await connect()
let tab
try {
  if (!c) throw Error('CDP unavailable')
  const opened = await openGuiTab(c,{baseUrl:'http://192.168.1.100:3080',width:390,height:844})
  tab = opened.tab
  const sid = tab.sessionId
  if (!opened.booted || !(await ensureNonEmptySession(c,sid)).ok) throw Error('GUI/header unavailable')
  const ev = value => c.evaluate(sid,value)
  const viewport = async width => { await setViewport(c,sid,{width,height:844}); await sleep(600) }
  const toggle = `(() => {const bs=document.querySelector('[data-slot="sidebar"] > *')?.firstElementChild?.querySelectorAll('button');if(!bs?.length)throw Error('native toggle missing');bs[bs.length-1].click();return true})()`
  const sideState = async () => JSON.parse(await ev(`(() => {
    const f=document.querySelector('[data-slot="root"] > *'),s=document.querySelector('[data-slot="sidebar"]'),center=f.querySelector(':scope > [class*="_centerCol"]');
    const box=e=>({x:e.getBoundingClientRect().x,w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height});
    return JSON.stringify({vw:innerWidth,collapsed:f.hasAttribute('data-sidebar-collapsed'),sidebar:box(s.parentElement),content:box(s.firstElementChild),center:box(center),centerVisible:getComputedStyle(center).visibility,overflow:document.documentElement.scrollWidth>innerWidth});})()`))
  const settingsState = async () => JSON.parse(await ev(`(() => {
    const p=document.querySelector('[data-shortcut-modal="settings"]');if(!p)return JSON.stringify({present:false});
    const n=p.querySelector(':scope > nav'),content=p.querySelector(':scope > [class*="_content"]'),options=content.querySelector('[class*="_options"]'),back=p.querySelector('[data-meow-settings-back]'),close=p.querySelector('[class*="_close"]');
    const box=e=>e?{x:e.getBoundingClientRect().x,w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height,display:getComputedStyle(e).display,visible:getComputedStyle(e).visibility}:null;
    return JSON.stringify({present:true,vw:innerWidth,vh:innerHeight,panel:box(p),nav:box(n),content:box(content),options:box(options),back:box(back),close:box(close),page:p.getAttribute('data-meow-smooth-settings'),selected:n.querySelector('[aria-current="true"]')?.textContent.trim(),overflow:p.scrollWidth>p.clientWidth});})()`))
  await viewport(390)
  if (!installed) {
    const bundle=captureBundleText(readFileSync(new URL('../lib/client.js',import.meta.url),'utf8'))
    await ev(`${RUN_BUNDLE}\n${REACT_STUB}\n${CTX_STUB}\nglobalThis.__meowBundleText=${JSON.stringify(bundle)};true`)
    await ev(`(() => {const original=globalThis.__meowCtx;globalThis.__registrations=[];globalThis.__meowCtx=()=>{const b=original();b.ctx.layout.toggleSidebar=()=>${toggle};b.ctx.slots.inject=(_name,cb)=>cb();b.ctx.slots.register=(entry)=>{globalThis.__registrations.push(entry.id);return {}};return b};return true})()`)
    await ev(STEP_CAPTURE); await ev(STEP_FACTORY)
    const applied=JSON.parse(await ev(STEP_APPLY))
    if(applied.applyError||!applied.hasClientDispose)throw Error(JSON.stringify(applied))
    const registrations=await ev('JSON.stringify(globalThis.__registrations)').then(JSON.parse)
    check('no-extra-send-registration',!registrations.includes('meow-smooth-run-send'),registrations)
    check('legacy-photo-registration-removed',!registrations.includes('meow-smooth-photo'),registrations)
  } else {
    check('no-extra-send-button',await ev('document.querySelectorAll("[data-meow-run-send]").length')===0,'actual loaded DOM')
  }
  for(const width of [320,390,767]) {
    await viewport(width)
    if(!(await sideState()).collapsed){await ev(toggle);await sleep(700)}
    await tapSelector(c,sid,'[data-meow-smooth-title-claimed]');await sleep(750)
    const s=await sideState()
    check(`sidebar-full-${width}`,!s.collapsed&&Math.abs(s.sidebar.w-width)<2&&Math.abs(s.content.w-width)<2,s)
    check(`conversation-not-squeezed-${width}`,Math.abs(s.center.w-width)<2&&s.center.x>=width-1&&!s.overflow,s)
    await ev(toggle);await sleep(750)
    const closed=await sideState()
    check(`sidebar-closes-${width}`,closed.collapsed&&closed.center.x<1&&Math.abs(closed.center.w-width)<2,closed)
  }
  await viewport(390)
  await tapSelector(c,sid,'[data-meow-smooth-title-claimed]');await sleep(700)
  await tapSelector(c,sid,'[data-slot="sidebar"] button[aria-label="设置"]');await sleep(650)
  const menu=await settingsState()
  if(!menu.present)throw Error('settings did not open')
  check('settings-directory-full',menu.page==='menu'&&Math.abs(menu.nav.w-390)<2&&menu.panel.h===844,menu)
  check('settings-options-hidden-in-menu',menu.options.display==='none'||menu.options.visible==='hidden',menu)
  check('settings-close-available',menu.close.w>0&&menu.close.x+menu.close.w<=390,menu)
  // 点击分类一次就进入；只导航，不修改配置。
  const modelPoint=JSON.parse(await ev(`(() => {const model=[...document.querySelectorAll('[data-shortcut-modal="settings"] > nav button')].find(b=>b.textContent.trim()==='模型');if(!model)throw Error('model category missing');const r=model.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2,hit:model.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})})()`))
  check('settings-category-hit-target',modelPoint.hit,modelPoint)
  await tap(c,sid,modelPoint);await sleep(650)
  const detail=await settingsState()
  check('settings-category-full',detail.page==='detail'&&detail.selected==='模型'&&detail.nav.w===0&&Math.abs(detail.content.w-390)<2&&!detail.overflow,detail)
  check('settings-back-available',detail.back?.w>0&&detail.back.h>=44,detail)
  check('settings-detail-focus',await ev('document.activeElement?.hasAttribute("data-meow-settings-back")')===true,'focus moved off hidden nav')
  for(const width of [320,767]){await viewport(width);const state=await settingsState();check('settings-detail-width-'+width,state.page==='detail'&&Math.abs(state.content.w-width)<2&&state.nav.w===0&&!state.overflow,state)}
  await viewport(390)
  await tapSelector(c,sid,'[data-meow-settings-back]');await sleep(350)
  check('settings-back-to-directory',(await settingsState()).page==='menu',await settingsState())
  await tapSelector(c,sid,'[data-shortcut-modal="settings"] > nav [aria-current="true"]');await sleep(400)
  check('selected-category-reopens-detail',(await settingsState()).page==='detail',await settingsState())
  await tapSelector(c,sid,closeSelector);await sleep(500)
  check('settings-native-close',!(await settingsState()).present,await settingsState())
  await tapSelector(c,sid,'[data-slot="sidebar"] button[aria-label="设置"]');await sleep(500)
  check('settings-reopen-starts-directory',(await settingsState()).page==='menu',await settingsState())
  await viewport(768)
  const edge=await settingsState()
  check('settings-desktop-boundary',edge.page===null&&edge.nav.w>100&&edge.content.w>100,edge)
  await viewport(1024)
  const desktop=await settingsState()
  check('desktop-settings-split',desktop.page===null&&desktop.nav.w>100&&desktop.content.w>100&&(!desktop.back||desktop.back.w===0),desktop)
  await tapSelector(c,sid,closeSelector);await sleep(400)
  const desktopSide=await sideState()
  check('desktop-sidebar-not-fullscreen',desktopSide.sidebar.w<500&&desktopSide.center.w>100,desktopSide)
  await viewport(390)
  if((await sideState()).collapsed){await ev(toggle);await sleep(700)}
  const sessionTarget=await ev(`(() => {const rows=[...document.querySelectorAll('[data-slot="sidebar"] [data-row-key^="session:"]')];return rows.find(r=>r.getBoundingClientRect().width>0)?.getAttribute('data-row-key')??null})()`)
  if(!sessionTarget)throw Error('no session row for navigation check')
  await tapSelector(c,sid,'[data-row-key='+JSON.stringify(sessionTarget)+']');await sleep(1200)
  check('select-session-returns-to-conversation',(await sideState()).collapsed&&(await sideState()).center.x<1,await sideState())
  const composer=await ev(`JSON.stringify([...document.querySelectorAll('[data-composer-card] button')].filter(b=>!b.hasAttribute('data-meow-run-send')).map(b=>({label:b.getAttribute('aria-label'),title:b.title,type:b.getAttribute('type')})))`).then(JSON.parse)
  check('native-send-stop-preserved',composer.some(b=>/^(发送|停止生成)/.test(b.label??'')),composer)
  check('native-attachment-preserved',composer.some(b=>b.label==='添加文件或调用指令'),composer)
  if(!installed){await ev(RUN_DISPOSE_EFFECT_ONLY);await ev(RUN_DISPOSE_WINDOW);check('mobile-page-resources-cleaned',await ev('document.querySelectorAll("[data-meow-sidebar-mobile-css],[data-meow-settings-back],[data-meow-smooth-settings]").length')===0,'disposers')}
}catch(e){check('runner',false,String(e.stack??e))}finally{await tab?.close();c?.close()}
console.log(`RESULT ${checks.filter(x=>x.ok).length}/${checks.length}`);process.exit(checks.every(x=>x.ok)?0:1)

#!/usr/bin/env node
/** Real GUI regressions for menu text, global navigation and icon-free page titles. */
import { readFileSync } from 'node:fs'
import { connect, setViewport, sleep, tapSelector } from '../tests/header-mobile/cdp.mjs'
import { openGuiTab, ensureNonEmptySession } from '../tests/header-mobile/fixture.mjs'
import { RUN_BUNDLE, REACT_STUB, CTX_STUB, STEP_CAPTURE, STEP_FACTORY, STEP_APPLY, RUN_DISPOSE_EFFECT_ONLY, RUN_DISPOSE_WINDOW, captureBundleText } from '../tests/header-mobile/integration.mjs'
const installed=process.argv.includes('--installed'),checks=[]
const check=(name,ok,detail)=>{checks.push({name,ok,detail});console.log(`${ok?'PASS':'FAIL'} ${name}: ${JSON.stringify(detail)}`)}
const c=await connect();let tab
try {
  if(!c)throw Error('CDP unavailable')
  const opened=await openGuiTab(c,{baseUrl:'http://192.168.1.100:3080',width:390,height:844});tab=opened.tab
  const sid=tab.sessionId,ev=value=>c.evaluate(sid,value)
  if(!opened.booted||!(await ensureNonEmptySession(c,sid)).ok)throw Error('GUI/session unavailable')
  const viewport=async width=>{await setViewport(c,sid,{width,height:844});await sleep(550)}
  const collapsed=()=>ev(`document.querySelector('[data-slot="root"] > *').hasAttribute('data-sidebar-collapsed')`)
  const toggle=`(()=>{const bs=document.querySelector('[data-slot="sidebar"] > *')?.firstElementChild?.querySelectorAll('button');if(!bs?.length)throw Error('toggle missing');bs[bs.length-1].click();return true})()`
  await viewport(390)
  if(!installed){
    const bundle=captureBundleText(readFileSync(new URL('../lib/client.js',import.meta.url),'utf8'))
    await ev(`${RUN_BUNDLE}\n${REACT_STUB}\n${CTX_STUB}\nglobalThis.__meowBundleText=${JSON.stringify(bundle)};true`)
    await ev(`(()=>{const old=globalThis.__meowCtx;globalThis.__meowCtx=()=>{const b=old();b.ctx.layout.toggleSidebar=()=>${toggle};return b};return true})()`)
    await ev(STEP_CAPTURE);await ev(STEP_FACTORY);const a=JSON.parse(await ev(STEP_APPLY));if(a.applyError||!a.hasClientDispose)throw Error(JSON.stringify(a))
  }
  const jobTrigger='[data-slot="conversation.session.header.actions"] > * > button[aria-expanded]:not([aria-haspopup])'
  await tapSelector(c,sid,jobTrigger);await sleep(450)
  const finished=JSON.parse(await ev(`(()=>{const b=[...document.querySelectorAll('ul[aria-label="后台任务"] button')].find(b=>b.textContent.trim().startsWith('已结束'));if(!b)return JSON.stringify({found:false});if(b.getAttribute('aria-expanded')!=='true')b.click();return JSON.stringify({found:true})})()`))
  await sleep(350)
  check('finished-jobs-included',finished.found,finished)
  for(const width of [320,390,767,1024]){
    await viewport(width)
    const rows=JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('ul[aria-label="后台任务"] span[class*="_label"],ul[aria-label="后台任务"] span[class*="_duration"]')].map(e=>({kind:e.className,font:parseFloat(getComputedStyle(e).fontSize),display:getComputedStyle(e).display,w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height})))`))
    check('job-text-readable-'+width,rows.length>0&&rows.every(r=>r.font>=10&&r.w>0&&r.h>0&&r.display!=='none'),{count:rows.length,bad:rows.filter(r=>r.font<10||r.w===0||r.h===0).slice(0,5)})
  }
  await viewport(390)
  await tapSelector(c,sid,'ul[aria-label="后台任务"] button[class*="_row"][aria-expanded]');await sleep(400)
  const row=JSON.parse(await ev(`(()=>{const r=document.querySelector('ul[aria-label="后台任务"] button[class*="_row"][aria-expanded]');return JSON.stringify({expanded:r?.getAttribute('aria-expanded'),changedLabels:[...document.querySelectorAll('ul[aria-label="后台任务"] span[title]')].filter(e=>e.style.fontSize||e.style.maxWidth||e.dataset.meowFoldModeExpanded).length})})()`))
  check('job-row-expands-without-preset-styling',row.expanded==='true'&&row.changedLabels===0,row)
  await tapSelector(c,sid,jobTrigger);await sleep(300)
  for(const label of ['文件','插件','自动化任务']){
    for(const width of [320,390,767]){
      await viewport(width)
      if(await collapsed()){await ev(toggle);await sleep(650)}
      await tapSelector(c,sid,'[data-slot="sidebar"] nav button[aria-label='+JSON.stringify(label)+']');await sleep(650)
      check('global-navigation-collapses-'+label+'-'+width,await collapsed(),{label,width})
      // 全局页面是懒加载模块，等原生主标题挂载再验证增强，不能用固定650ms猜加载时间。
      const pageReady=await c.waitFor(sid,`document.querySelector('[data-slot="main"] h1')?.textContent===${JSON.stringify(label)}`,{timeoutMs:10000})
      if(pageReady!==true)throw Error('global page did not mount: '+label)
      // 即使收起失败也手动收起，以独立验证残留图标而不是级联失败。
      if(!await collapsed()){await ev(toggle);await sleep(600)}
      const h=JSON.parse(await ev(`(()=>{const h=document.querySelector('[data-slot="main"] h1'),fab=document.querySelector('[data-meow-smooth-fab]');return JSON.stringify({text:h?.textContent,claimed:h?.hasAttribute('data-meow-smooth-title-claimed'),role:h?.getAttribute('role'),tabindex:h?.getAttribute('tabindex'),h:h?.getBoundingClientRect().height,icon:h?getComputedStyle(h,'::before').content:null,fabVisible:!!fab&&fab.getBoundingClientRect().width>0})})()`))
      check('global-title-no-icon-'+label+'-'+width,h.text===label&&h.claimed&&h.role==='button'&&h.tabindex==='0'&&h.h>=44&&h.icon==='none'&&!h.fabVisible,h)
      await tapSelector(c,sid,'[data-slot="main"] h1');await sleep(650)
      check('global-title-opens-sidebar-'+label+'-'+width,!await collapsed(),{label,width})
    }
    await viewport(1024)
    const wide=JSON.parse(await ev(`(()=>{const h=document.querySelector('[data-slot="main"] h1');return JSON.stringify({role:h?.getAttribute('role'),tabindex:h?.getAttribute('tabindex'),claimed:h?.hasAttribute('data-meow-smooth-title-claimed')})})()`))
    check('desktop-title-original-'+label,wide.role===null&&!wide.claimed&&(label!=='自动化任务'||wide.tabindex==='-1'),wide)
  }
  if(!installed){await ev(RUN_DISPOSE_EFFECT_ONLY);await ev(RUN_DISPOSE_WINDOW);check('title-cleanup',await ev('document.querySelectorAll("[data-meow-smooth-title-claimed]").length')===0,'no owned title attributes')}
}catch(e){check('runner',false,String(e.stack??e))}finally{await tab?.close();c?.close()}
console.log(`RESULT ${checks.filter(c=>c.ok).length}/${checks.length}`);process.exit(checks.every(c=>c.ok)?0:1)

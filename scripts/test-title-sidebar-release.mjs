#!/usr/bin/env node
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {connect,setViewport,sleep,tapSelector,tap} from '../tests/header-mobile/cdp.mjs';
import {openGuiTab,ensureNonEmptySession} from '../tests/header-mobile/fixture.mjs';
import {RUN_BUNDLE,REACT_STUB,CTX_STUB,STEP_CAPTURE,STEP_FACTORY,STEP_APPLY,RUN_DISPOSE_EFFECT_ONLY,RUN_DISPOSE_WINDOW,captureBundleText} from '../tests/header-mobile/integration.mjs';
const checks=[];const check=(name,ok,data)=>{checks.push(ok);console.log((ok?'PASS':'FAIL')+' '+name+' '+JSON.stringify(data))};
const diagnostics=[];
const cdp=await connect();let tab;
try{
const opened=await openGuiTab(cdp,{baseUrl:'http://192.168.1.100:3080',width:390,height:844});tab=opened.tab;const sid=tab.sessionId;
if(!opened.booted||!(await ensureNonEmptySession(cdp,sid)).ok)throw Error('GUI unavailable');
const ev=s=>cdp.evaluate(sid,s);const vp=async width=>{await setViewport(cdp,sid,{width,height:844});await sleep(650)};
const ts='[data-slot="conversation.header"] [class*="_crumbCurrent"]';
const toggle=`(()=>{const b=document.querySelector('[data-slot="sidebar"] > *')?.firstElementChild?.querySelectorAll('button');if(!b?.length)throw Error("toggle missing");b[b.length-1].click();return true})()`;
const diagnose=async(label)=>{const d=JSON.parse(await ev(`(()=>{const f=document.querySelector('[data-meow-smooth-fab]'),h=document.querySelector('[data-slot="conversation.session.header"] > header'),r=document.querySelector('[data-slot="root"] > *'),html=document.documentElement,cs=f?getComputedStyle(f):null,b=f?.getBoundingClientRect(),top=b&&b.width&&b.height?document.elementFromPoint(b.x+b.width/2,b.y+b.height/2):null,pending=[...document.querySelectorAll('[data-meow-smooth-pending]')].map(x=>({visible:x.getAttribute('data-visible'),mode:x.getAttribute('data-mode')})),dialogs=[...document.querySelectorAll('div[role="dialog"]')].length;return JSON.stringify({label:${JSON.stringify(label)},htmlAttrs:[...html.attributes].map(a=>[a.name,a.value]),viewport:{width:innerWidth,height:innerHeight,coarse:matchMedia('(pointer: coarse)').matches},frame:r?{collapsed:r.hasAttribute('data-sidebar-collapsed'),width:r.getBoundingClientRect().width}:null,furl:html.getAttribute('data-meow-smooth-furled'),ime:html.getAttribute('data-meow-smooth-ime'),header:h?{display:getComputedStyle(h).display,empty:h.firstElementChild===null}:null,fab:f?{attrs:[...f.attributes].map(a=>[a.name,a.value]),display:cs.display,visibility:cs.visibility,opacity:cs.opacity,rect:{x:b.x,y:b.y,w:b.width,h:b.height},zIndex:cs.zIndex,topElement:top?.getAttribute('data-slot')||top?.tagName}:null,hideConditions:{dialogCount:dialogs,pending,ime:html.hasAttribute('data-meow-smooth-ime'),headerHidden:f?.hasAttribute('data-meow-smooth-header-hidden')??false,furl:html.getAttribute('data-meow-smooth-furled')==='true'},titleSlot:!!document.querySelector('[data-slot="conversation.header"]'),sessionHeaderSlot:!!document.querySelector('[data-slot="conversation.session.header"]')})})()`));diagnostics.push(d);console.log('DIAG '+JSON.stringify(d));return d};
const snap=async()=>JSON.parse(await ev(`(()=>{const t=document.querySelector(${JSON.stringify(ts)}),f=document.querySelector("[data-meow-smooth-fab]"),r=document.querySelector('[data-slot="root"] > *'),p=document.querySelector('[data-slot="conversation.header"] [class*="_crumbs"]');return JSON.stringify({claimed:t?.hasAttribute("data-meow-smooth-title-claimed"),role:t?.getAttribute("role"),h:t?.getBoundingClientRect().height,glyph:t?getComputedStyle(t,"::before").backgroundImage:null,glyphContent:t?getComputedStyle(t,"::before").content:null,padding:p?getComputedStyle(p).paddingInlineStart:null,fabVisible:!!f&&f.getBoundingClientRect().width>0,fw:f?.getBoundingClientRect().width,fh:f?.getBoundingClientRect().height,fg:f?getComputedStyle(f,"::before").backgroundImage:null,collapsed:r?.hasAttribute("data-sidebar-collapsed"),marker:document.documentElement.hasAttribute("data-meow-smooth-title-entry"),sheets:document.querySelectorAll("[data-meow-title-sidebar-entry-css]").length,overflow:document.documentElement.scrollWidth>innerWidth})})()`));
await vp(390);
if(!process.argv.includes('--installed')){
const bundle=captureBundleText(readFileSync(new URL('../lib/client.js',import.meta.url),'utf8'));
await ev(RUN_BUNDLE+REACT_STUB+CTX_STUB+';globalThis.__meowBundleText='+JSON.stringify(bundle)+';true');
await ev('(()=>{const orig=globalThis.__meowCtx;globalThis.__meowCtx=()=>{const b=orig();b.ctx.layout.toggleSidebar=()=>'+toggle+';return b};return true})()');
await ev(STEP_CAPTURE);await ev(STEP_FACTORY);const a=JSON.parse(await ev(STEP_APPLY));if(a.applyError||!a.hasClientDispose)throw Error(JSON.stringify(a));}
for(const w of [320,390,430,767]){await vp(w);const s=await snap();check('title-'+w,s.claimed&&s.role==='button'&&s.h>=44&&s.glyph==='none'&&s.glyphContent==='none',s);check('space-'+w,!s.fabVisible&&s.padding==='0px'&&!s.overflow,s)}
await vp(390);await tapSelector(cdp,sid,ts);await sleep(900);check('click-opens',(await snap()).collapsed===false,await snap());
await ev('document.querySelector('+JSON.stringify(ts)+')?.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));true');await sleep(900);check('already-open-stays-open',(await snap()).collapsed===false,await snap());
// 保留真实边缘手势；全屏侧栏没有外侧空白，使用原生收起按钮返回。
if(!(await snap()).collapsed){await ev(toggle);await sleep(900)}
await cdp.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:4,y:210}]},sid);
for(const x of [28,62,105,155,210]){await cdp.call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:210}]},sid);await sleep(30)}
await cdp.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]},sid);await sleep(900);
check('edge-swipe-opens',(await snap()).collapsed===false,await snap());
await tapSelector(cdp,sid,'[data-slot="sidebar"] > * > :first-child > button:last-child');await sleep(900);
check('native-toggle-closes',(await snap()).collapsed===true,await snap());
for(const w of [768,1024]){await vp(w);const s=await snap();check('desktop-'+w,!s.claimed&&s.role===null&&s.glyph==='none',s)}
await vp(390);await ev(`(()=>{const h=document.querySelector('[data-slot="conversation.header"]');window.__oldH=h;window.__hp=h.parentNode;window.__hn=h.nextSibling;h.remove();return true})()`);await sleep(900);
check('removed-slot-releases',!(await snap()).marker,await snap());
if(!(await snap()).collapsed){await ev(toggle);await sleep(900)}await diagnose('fallback-before-compact');const f=await snap();check('fallback-compact',f.fabVisible&&f.fw===44&&f.fh===44&&f.fg!=='none',f);
await tapSelector(cdp,sid,'[data-meow-smooth-fab]');await sleep(900);await diagnose('fallback-after-click');check('fallback-opens',(await snap()).collapsed===false,await snap());
await ev('window.__hp.insertBefore(window.__oldH,window.__hn?.isConnected?window.__hn:null);true');await sleep(900);check('remount-reclaims',(await snap()).claimed,await snap());
if(!process.argv.includes('--installed')){await ev(RUN_DISPOSE_EFFECT_ONLY);await sleep(200);const s=await snap();check('effect-cleans',!s.claimed&&!s.marker&&s.sheets===0,s);await ev(RUN_DISPOSE_WINDOW);check('double-dispose',(await snap()).sheets===0,await snap());}
}catch(e){check('runner',false,String(e.stack??e))}finally{await tab?.close();cdp?.close();const dir=fileURLToPath(new URL('../artifacts/native-height-tests/',import.meta.url));mkdirSync(dir,{recursive:true});const p=join(dir,'title-sidebar-fab-diagnostic.json');writeFileSync(p,JSON.stringify({startedAt:new Date().toISOString(),mode:process.argv.includes('--installed')?'installed':'bundle-apply',diagnostics},null,2)+'\n');console.log('DIAGNOSTIC '+p)}
console.log('RESULT '+checks.filter(Boolean).length+'/'+checks.length);process.exit(checks.every(Boolean)?0:1);

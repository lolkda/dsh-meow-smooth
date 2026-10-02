#!/usr/bin/env node
/** Verify native keyboard propagation safely, without sending any actual conversation message. */
import {readFileSync} from 'node:fs'
import {connect,setViewport,sleep} from '../tests/header-mobile/cdp.mjs'
import {openGuiTab,ensureNonEmptySession} from '../tests/header-mobile/fixture.mjs'
import {RUN_BUNDLE,REACT_STUB,CTX_STUB,STEP_CAPTURE,STEP_FACTORY,STEP_APPLY,captureBundleText} from '../tests/header-mobile/integration.mjs'
const installed=process.argv.includes('--installed'),checks=[]
const check=(name,ok,detail)=>{checks.push(ok);console.log(`${ok?'PASS':'FAIL'} ${name}: ${JSON.stringify(detail)}`)}
const c=await connect();let tab
try{
 if(!c)throw Error('CDP unavailable')
 const opened=await openGuiTab(c,{baseUrl:'http://192.168.1.100:3080',width:390,height:844});tab=opened.tab
 const sid=tab.sessionId,ev=s=>c.evaluate(sid,s)
 if(!opened.booted||!(await ensureNonEmptySession(c,sid)).ok)throw Error('GUI unavailable')
 await setViewport(c,sid,{width:390,height:844})
 const pickerBefore=await ev('document.querySelectorAll("[data-composer-card] input[type=file]").length')
 if(!installed){
  const bundle=captureBundleText(readFileSync(new URL('../lib/client.js',import.meta.url),'utf8'))
  await ev(`${RUN_BUNDLE}\n${REACT_STUB}\n${CTX_STUB}\nglobalThis.__meowBundleText=${JSON.stringify(bundle)};true`)
  await ev(`(()=>{const original=globalThis.__meowCtx;globalThis.__registered=[];globalThis.__meowCtx=()=>{const b=original();b.ctx.slots.inject=(_name,cb)=>cb();b.ctx.slots.register=entry=>{globalThis.__registered.push(entry.id);return {}};return b};return true})()`)
  await ev(STEP_CAPTURE);await ev(STEP_FACTORY)
  const applied=JSON.parse(await ev(STEP_APPLY));if(applied.applyError||!applied.hasClientDispose)throw Error(JSON.stringify(applied))
  const registered=await ev('JSON.stringify(globalThis.__registered)').then(JSON.parse)
  check('no-legacy-photo-slot',!registered.includes('meow-smooth-photo'),registered)
  check('no-extra-send-slot',!registered.includes('meow-smooth-run-send'),registered)
 }
 // A synthetic composer OUTSIDE the React application: only our local recipient runs,
 // preventing defaults and stopping propagation before any host submission could occur.
 const results=await ev(`JSON.stringify((()=>{
  const result=[];
  for(const kind of ['textarea','contenteditable']){
   const card=document.createElement('div');card.setAttribute('data-composer-card','');card.style.cssText='position:fixed;top:100px;left:10px;width:260px;z-index:20000';
   const input=document.createElement(kind==='textarea'?'textarea':'div');
   if(kind==='contenteditable'){input.contentEditable='true';input.setAttribute('data-composer-input','')}
   input.setAttribute('enterkeyhint','send');card.append(input);document.body.append(card);
   input.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));input.focus();
   const focused=document.activeElement===input,hint=input.getAttribute('enterkeyhint');
   let received=0;input.addEventListener('keydown',e=>{received++;e.preventDefault();e.stopPropagation()});
   const cases=[['Enter',{}],['Shift+Enter',{shiftKey:true}],['Ctrl+Enter',{ctrlKey:true}],['IME Enter',{isComposing:true}],['Other key',{key:'a'}]];
   for(const [name,opts]of cases){const before=received;input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...opts}));result.push({kind,name,received:received-before,focused,hint})}
   card.remove();
  }
  return result;
 })())`).then(JSON.parse)
 for(const kind of ['textarea','contenteditable']){
  const rows=results.filter(x=>x.kind===kind)
  check(`${kind}-native-keyboard-hint`,rows.every(x=>x.focused&&x.hint==='send'),rows[0])
  for(const row of rows)check(`${kind}-${row.name}-reaches-recipient`,row.received===1,row)
 }
 check('native-file-input-kept',pickerBefore>0&&(await ev('document.querySelectorAll("[data-composer-card] input[type=file]").length'))===pickerBefore,{pickerBefore})
 check('no-legacy-photo-button',await ev('document.querySelectorAll("[data-meow-photo-picker]").length')===0,'DOM')
 const controls=await ev(`JSON.stringify([...document.querySelectorAll('[data-composer-card] button')].map(b=>b.getAttribute('aria-label')))`).then(JSON.parse)
 check('native-submit-control-kept',controls.some(x=>/^(发送|停止生成)/.test(x??'')),controls)
 check('native-attachment-control-kept',controls.includes('添加文件或调用指令'),controls)
}catch(e){check('runner',false,String(e.stack??e))}finally{await tab?.close();c?.close()}
console.log(`RESULT ${checks.filter(Boolean).length}/${checks.length}`);process.exit(checks.every(Boolean)?0:1)

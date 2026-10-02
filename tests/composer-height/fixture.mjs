/** Browser-side isolated composer fixture. It lives outside the React tree and has no submit path. */
export const CREATE_FIXTURE = `
(() => {
  const id = 'native-height-' + Math.random().toString(36).slice(2);
  const card = document.createElement('section');
  card.id = id;
  card.setAttribute('data-composer-card', '');
  card.setAttribute('data-height-test-unrelated', 'keep-me');
  card.style.cssText = 'position:fixed;left:12px;top:300px;width:360px;height:220px;z-index:2147483647;background:white;color:black;border:1px solid black;';
  const scroll = document.createElement('div');
  scroll.setAttribute('data-input-scroll', '');
  scroll.style.cssText = 'height:140px;width:340px;overflow:auto;max-height:none;';
  const input = document.createElement('div');
  input.style.cssText = 'box-sizing:border-box;width:320px;height:520px;min-height:520px;line-height:24px;padding:4px;';
  const kind = __KIND__;
  if (kind === 'textarea') {
    const textarea = document.createElement('textarea');
    textarea.value = ('long draft line with enough content to exercise a native multiline composer.\\n').repeat(30);
    textarea.setAttribute('enterkeyhint', 'send');
    textarea.style.cssText = input.style.cssText + 'resize:none;';
    scroll.append(textarea);
    input.remove();
  } else {
    input.contentEditable = 'true';
    input.setAttribute('data-composer-input', '');
    input.setAttribute('enterkeyhint', 'send');
    input.textContent = ('long draft line with enough content to exercise a native multiline composer.\\n').repeat(30);
    scroll.append(input);
  }
  card.append(scroll);
  const outside = document.createElement('button');
  outside.type = 'button';
  outside.textContent = 'isolated test focus target';
  outside.setAttribute('data-height-test-focus', id);
  outside.style.cssText = 'position:fixed;left:390px;top:30px;z-index:20001;';
  const cardAction = document.createElement('button');
  cardAction.type = 'button';
  cardAction.textContent = 'inside composer card';
  cardAction.style.cssText = 'position:absolute;left:4px;bottom:4px;z-index:1;';
  card.append(cardAction);
  outside.style.top = '530px';
  const outsideClick = document.createElement('div');
  outsideClick.textContent = 'isolated outside click target';
  outsideClick.style.cssText = 'position:fixed;left:12px;top:560px;width:200px;height:30px;z-index:2147483647;background:#eee;';
  outsideClick.setAttribute('data-height-test-outside', id);
  document.body.append(card, outside, outsideClick);
  const editable = kind === 'textarea' ? scroll.querySelector('textarea') : input;
  scroll.scrollTop = 36;
  const before = snapshot(card, scroll, editable);
  return JSON.stringify({ id, kind, before });

  function snapshot(c, s, el) {
    const cs = getComputedStyle(s);
    return {
      height: +s.getBoundingClientRect().height.toFixed(2),
      maxHeight: cs.maxHeight,
      scrollTop: s.scrollTop,
      foldAttr: c.getAttribute('data-meow-smooth'),
      foldHeight: c.style.getPropertyValue('--meow-smooth-fold-height'),
      draftLength: el instanceof HTMLTextAreaElement ? el.value.length : (el.textContent || '').length,
      unrelatedAttr: c.getAttribute('data-height-test-unrelated'),
    };
  }
})()
`.replace('__KIND__', JSON.stringify('contenteditable'))

export function createFixtureExpression(kind) {
  if (!['textarea', 'contenteditable'].includes(kind)) throw new Error(`unsupported fixture kind: ${kind}`)
  return CREATE_FIXTURE.replace(JSON.stringify('contenteditable'), JSON.stringify(kind))
}

export function fixtureSnapshotExpression(id) {
  return `(() => {
    const c = document.getElementById(${JSON.stringify(id)});
    if (!c) return null;
    const s = c.querySelector('[data-input-scroll]');
    const el = s.querySelector('textarea, [data-composer-input]');
    const cs = getComputedStyle(s);
    return JSON.stringify({height:+s.getBoundingClientRect().height.toFixed(2),maxHeight:cs.maxHeight,
      scrollTop:s.scrollTop,foldAttr:c.getAttribute('data-meow-smooth'),
      foldHeight:c.style.getPropertyValue('--meow-smooth-fold-height'),
      draftLength:el instanceof HTMLTextAreaElement?el.value.length:(el.textContent||'').length,
      unrelatedAttr:c.getAttribute('data-height-test-unrelated')});
  })()`
}

export function resetFixtureExpression(id) {
  return `(() => { const c=document.getElementById(${JSON.stringify(id)}); const s=c?.querySelector('[data-input-scroll]'); if(!c||!s)return false; c.removeAttribute('data-meow-smooth'); c.style.removeProperty('--meow-smooth-fold-height'); s.scrollTop=36; return true })()`
}

export function removeFixtureExpression(id) {
  return `(() => { document.getElementById(${JSON.stringify(id)})?.remove(); document.querySelector('[data-height-test-focus="${id}"]')?.remove(); document.querySelector('[data-height-test-outside="${id}"]')?.remove(); return true })()`
}

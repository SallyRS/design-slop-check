// Runs inside the page (injected by check.mjs). Reads computed styles and
// layout and returns raw hits for the script-checked patterns, plus the facts
// the judgement step needs. Read-only: it never changes the page except when
// check.mjs asks it to show one slide at a time.
(() => {
  if (window.__dsc) return;
  const MAX_ELEMENTS = 8000;

  // ---------- color ----------
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const colorCache = new Map();
  function rgba(str) {
    if (!str) return null;
    if (colorCache.has(str)) return colorCache.get(str);
    let out = null;
    if (str === 'transparent' || /^rgba?\([^)]*,\s*0\)$/.test(str)) out = { r: 0, g: 0, b: 0, a: 0 };
    else {
      cx.clearRect(0, 0, 1, 1);
      cx.fillStyle = '#000'; cx.fillStyle = str;
      cx.fillRect(0, 0, 1, 1);
      const d = cx.getImageData(0, 0, 1, 1).data;
      out = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    }
    colorCache.set(str, out);
    return out;
  }
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  function oklch(c) {
    const r = lin(c.r), g = lin(c.g), b = lin(c.b);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    let h = Math.atan2(B, A) * 180 / Math.PI; if (h < 0) h += 360;
    return { L, C: Math.hypot(A, B), h, A, B };
  }
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const dE = (a, b) => { const p = oklch(a), q = oklch(b); return Math.hypot(p.L - q.L, p.A - q.A, p.B - q.B); };
  const hex = (c) => c ? '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('') : '';
  const hueDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

  // Classes this script adds (to show slides or finish reveals) are left out of selectors.
  const added = new WeakMap();
  const addClass = (el, c) => { if (el.classList.contains(c)) return; el.classList.add(c); if (!added.has(el)) added.set(el, new Set()); added.get(el).add(c); };
  // ---------- element helpers ----------
  const cs = (el) => getComputedStyle(el);
  const px = (v) => parseFloat(v) || 0;
  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = cs(el);
    if (s.visibility === 'hidden' || s.display === 'none') return false;
    let n = el; while (n && n.nodeType === 1) { if (cs(n).opacity === '0') return false; n = n.parentElement; }
    return true;
  }
  function ownText(el) {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    return t.replace(/\s+/g, ' ').trim();
  }
  const text = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const short = (s, n = 70) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  // Selectors must match exactly one element: findings are keyed on them, and a
  // fixing agent has to land on the right element.
  function cssPath(el) {
    const p = cssPathLoose(el);
    try { if (document.querySelectorAll(p).length === 1) return p; } catch { /* odd ids */ }
    const parts = []; let n = el;
    while (n && n.nodeType === 1 && n.tagName !== 'HTML') {
      if (n.id && /^[A-Za-z][\w-]*$/.test(n.id) && document.querySelectorAll('#' + n.id).length === 1) { parts.unshift('#' + n.id); break; }
      const parent = n.parentElement;
      const cls = [...n.classList].filter((c) => /^[A-Za-z_][\w-]*$/.test(c) && !(added.get(n) && added.get(n).has(c))).slice(0, 2);
      parts.unshift(n.tagName.toLowerCase() + (cls.length ? '.' + cls.join('.') : '') + (parent ? `:nth-child(${[...parent.children].indexOf(n) + 1})` : ''));
      const q = parts.join(' > ');
      try { if (document.querySelectorAll(q).length === 1) return q; } catch { /* keep going */ }
      n = parent;
    }
    return parts.join(' > ');
  }
  function cssPathLoose(el) {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < 4) {
      if (n.id && /^[A-Za-z][\w-]*$/.test(n.id)) { parts.unshift('#' + n.id); break; }
      let p = n.tagName.toLowerCase();
      const mine = added.get(n);
      const cls = [...n.classList].filter((c) => /^[A-Za-z_][\w-]*$/.test(c) && !(mine && mine.has(c))).slice(0, 2);
      if (cls.length) p += '.' + cls.join('.');
      const parent = n.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === n.tagName);
        if (same.length > 1 && !cls.length) p += `:nth-of-type(${same.indexOf(n) + 1})`;
      }
      parts.unshift(p);
      if (n.tagName === 'BODY') break;
      n = parent;
    }
    return parts.join(' > ');
  }
  function bgOf(el) {
    const c = rgba(cs(el).backgroundColor);
    return c && c.a > 0.05 ? c : null;
  }
  function effectiveBg(el) {
    let n = el;
    while (n && n.nodeType === 1) {
      const c = bgOf(n);
      if (c && c.a > 0.5) return c;
      n = n.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }
  function hasShadow(s) { return s.boxShadow && s.boxShadow !== 'none'; }
  function borderInfo(s) {
    const sides = ['Top', 'Right', 'Bottom', 'Left'].map((k) => ({
      w: px(s['border' + k + 'Width']), style: s['border' + k + 'Style'], c: rgba(s['border' + k + 'Color']),
    }));
    const vis = sides.filter((b) => b.w >= 1 && b.style !== 'none' && b.c && b.c.a > 0.1);
    return { all: vis.length === 4, any: vis.length > 0, sides };
  }
  function isBox(el) {
    if (/^(HTML|BODY|svg|IMG|PICTURE|VIDEO|CANVAS|BUTTON|INPUT|A|SPAN)$/i.test(el.tagName)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 24) return false;
    const s = cs(el);
    if (borderInfo(s).all || hasShadow(s)) return true;
    const bg = bgOf(el);
    if (!bg) return false;
    const parentBg = effectiveBg(el.parentElement || el);
    return dE(bg, parentBg) > 0.02;
  }
  const BTN_CLASS = /\b(btn|button|cta)\b/i;
  function isButton(el) {
    if (!visible(el)) return false;
    // Tabs and toggle groups are controls with their own look, not action buttons.
    if (/^(tab|switch|radio|menuitem|option)$/.test(el.getAttribute('role') || '') || el.hasAttribute('aria-pressed') || el.closest('[role=tablist],[role=radiogroup],[role=group],[role=menu]')) return false;
    const t = el.tagName;
    if (t === 'BUTTON' || (t === 'INPUT' && /^(button|submit)$/i.test(el.type))) return true;
    if (el.getAttribute('role') === 'button') return true;
    if (t === 'A') {
      if (BTN_CLASS.test(el.className || '')) return true;
      const s = cs(el);
      const filled = bgOf(el) || borderInfo(s).all;
      return !!filled && px(s.paddingLeft) >= 8 && text(el).length <= 40;
    }
    return false;
  }
  function btnStyle(el) {
    const s = cs(el);
    const bg = bgOf(el);
    const b = borderInfo(s);
    return {
      filled: !!bg,
      key: [bg ? hex(bg) : 'none', b.all ? hex(b.sides[0].c) + '/' + b.sides[0].w : 'noborder', Math.round(px(s.borderTopLeftRadius)), hex(rgba(s.color))].join('|'),
      radius: Math.round(px(s.borderTopLeftRadius)),
    };
  }
  const HEADING = 'h1,h2,h3,h4,h5,h6';
  const TEXT_BLOCKS = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,button,figcaption,dt,dd,td,th';
  const NUM_ONLY = /^[$€£¥]?\s?[\d][\d.,]*\s?(%|x|×|k|K|M|B|bn|\+|★|s|ms|h|\/\d+)?\+?$/;
  const MONO = /(mono|courier|consolas|menlo|monaco|jetbrains|fira code|source code|ui-monospace|monospace|ibm plex mono|space mono|roboto mono)/i;
  const SERIF_FACE = /(serif|georgia|times|garamond|playfair|fraunces|recoleta|newsreader|lora|merriweather|dm serif|instrument serif|cormorant|libre baskerville|crimson|source serif|eb garamond|baskerville|bodoni|didot)/i;
  const firstFamily = (s) => (s.fontFamily.split(',')[0] || '').replace(/["']/g, '').trim();
  const isSerif = (s) => { const f = firstFamily(s).toLowerCase(); return SERIF_FACE.test(f) && !/sans/.test(f); };
  const EMOJI = /\p{Extended_Pictographic}/u;
  const SPARKLE = /[✨❇✦✧✳]/u;

  function within(root, sel) {
    const list = [...root.querySelectorAll(sel)];
    return list.length > MAX_ELEMENTS ? list.slice(0, MAX_ELEMENTS) : list;
  }
  function allVisible(root) { return within(root, '*').filter((el) => !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|HEAD|META|LINK|TITLE)$/.test(el.tagName) && visible(el)); }

  // ---------- slides ----------
  const SLIDE_SELECTORS = ['.reveal .slides > section', 'section.slide', 'div.slide', '.slide', '[data-slide]', '.deck > section', '#impress > .step'];
  // A slide must fill most of the screen when shown, so lists of steps or
  // cards that happen to share a class name are not mistaken for a deck.
  const slideSized = (el) => { const r = el.getBoundingClientRect(); return r.width >= innerWidth * 0.5 && r.height >= innerHeight * 0.4; };
  function findSlides(custom) {
    if (custom) return [...document.querySelectorAll(custom)];
    // It is a deck only when the slides hold most of the page's text; a page
    // with a .slide hero carousel stays a web page.
    const textLen = (el) => { let n = (el.textContent || '').replace(/\s+/g, '').length; for (const x of el.querySelectorAll('script,style,noscript,template')) n -= (x.textContent || '').replace(/\s+/g, '').length; return n; };
    const all = textLen(document.body) || 1;
    for (const s of SLIDE_SELECTORS) {
      const list = [...document.querySelectorAll(s)].filter((el) => !el.parentElement.closest(s));
      if (list.length < 2 || !list.some(slideSized)) continue;
      const inside = list.reduce((n, el) => n + textLen(el), 0);
      if ((all - inside) / all <= 0.25) return list;
    }
    return [];
  }
  let slideState = null;
  function activateSlide(i, custom) {
    const slides = findSlides(custom);
    if (!slideState) {
      const shown = slides.find((s) => cs(s).display !== 'none') || slides[0];
      slideState = { display: shown ? cs(shown).display : 'block' };
      const st = document.createElement('style');
      st.id = 'dsc-slide-style';
      st.textContent = '[data-dsc-hidden]{display:none!important}[data-dsc-active]{visibility:visible!important;opacity:1!important;transform:none!important;}[data-dsc-active] .fragment{opacity:1!important;visibility:visible!important}';
      document.head.appendChild(st);
    }
    slides.forEach((s, j) => {
      if (j === i) {
        s.removeAttribute('data-dsc-hidden');
        s.setAttribute('data-dsc-active', '');
        ['active', 'present', 'current', 'is-active', 'visible'].forEach((c) => addClass(s, c));
        if (cs(s).display === 'none') s.style.setProperty('display', slideState.display === 'none' ? 'block' : slideState.display, 'important');
      } else {
        s.removeAttribute('data-dsc-active');
        s.setAttribute('data-dsc-hidden', '');
        ['active', 'present', 'current', 'is-active'].forEach((c) => s.classList.remove(c));
      }
    });
    window.scrollTo(0, 0);
    const r = slides[i].getBoundingClientRect();
    return { w: r.width, h: r.height };
  }

  // Makes scroll-triggered content visible for screenshots, after motion facts are read.
  function settleForScreenshot() {
    allCss(); // read the page's CSS before adding ours
    const st = document.createElement('style');
    st.id = 'dsc-settle-style';
    st.textContent = '*,*::before,*::after{transition:none!important;animation-delay:0s!important;animation-duration:0.001s!important;animation-iteration-count:1!important}';
    document.head.appendChild(st);
    for (const el of document.querySelectorAll('[data-aos],.reveal-on-scroll,.fade-up,.fade-in,.reveal:not(.reveal .slides *),[data-animate]')) {
      ['aos-animate', 'is-visible', 'in-view', 'visible', 'active', 'revealed', 'show'].forEach((c) => addClass(el, c));
    }
  }

  // Text drawn by ::before / ::after. Chrome reports attr() unresolved, so resolve it here.
  // Decodes CSS string escapes (\2728, \a , \") without ever throwing.
  function cssUnescape(str) {
    return str.replace(/\\([0-9a-fA-F]{1,6})\s?|\\([\s\S])/g, (_, h, ch) => {
      if (h) { const cp = parseInt(h, 16); return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '\ufffd'; }
      return ch === '\n' ? '' : ch;
    });
  }
  function pseudoText(el, pe) {
    try {
      const c = getComputedStyle(el, pe).content;
      if (!c || c === 'none' || c === 'normal') return '';
      let out = '';
      for (const m of c.matchAll(/"((?:[^"\\]|\\[\s\S])*)"|attr\(\s*([\w-]+)\s*\)/g)) out += m[1] !== undefined ? cssUnescape(m[1]) : (el.getAttribute(m[2]) || '');
      return out;
    } catch { return ''; }
  }
  // ---------- checks ----------
  function collect(root, ctx) {
    const hits = [];
    const add = (p, el, ev, extra = {}) => hits.push({
      p, sel: el ? cssPath(el) : null, text: el ? short(text(el), 80) : null, ev, conf: extra.conf || 'high',
      key: extra.key || (el ? cssPath(el) : String(p)), id: el && el.id ? el.id : null,
    });
    const rootRect = root === document.body ? { left: 0, top: 0, width: innerWidth, height: Math.max(innerHeight, document.documentElement.scrollHeight), right: innerWidth, bottom: document.documentElement.scrollHeight } : root.getBoundingClientRect();
    const els = allVisible(root);
    const isSlide = ctx.mode === 'slide';
    const vh = isSlide ? rootRect.height : innerHeight;

    // groups of equal siblings, shared by several checks
    const equalGroups = [];
    for (const parent of new Set(els.map((e) => e.parentElement).filter(Boolean))) {
      if (!root.contains(parent) && parent !== root) continue;
      const kids = [...parent.children].filter((k) => visible(k) && !/^(SCRIPT|STYLE|BR)$/.test(k.tagName));
      if (kids.length < 3 || kids.length > 8) continue;
      const rs = kids.map((k) => k.getBoundingClientRect());
      const w0 = rs[0].width, h0 = rs[0].height;
      if (w0 < 80 || h0 < 50) continue;
      const eq = rs.every((r) => Math.abs(r.width - w0) <= Math.max(6, w0 * 0.06) && Math.abs(r.height - h0) <= Math.max(6, h0 * 0.08));
      if (eq) equalGroups.push({ parent, kids });
    }
    const chartIn = (k) => [...k.querySelectorAll('svg,canvas')].some((g) => { const r = g.getBoundingClientRect(); const kr = k.getBoundingClientRect(); return r.width * r.height >= 0.25 * kr.width * kr.height; });
    const groupTaken = new Set();

    // P74 equal chart cards
    for (const g of equalGroups) {
      if (g.kids.every(chartIn)) {
        groupTaken.add(g.parent);
        add(74, g.parent, `${g.kids.length} chart cards of the same size (${Math.round(g.kids[0].getBoundingClientRect().width)}×${Math.round(g.kids[0].getBoundingClientRect().height)}px), none larger`);
      }
    }
    // P7 / P85 stat rows
    for (const parent of new Set(els.map((e) => e.parentElement).filter(Boolean))) {
      const kids = [...parent.children].filter(visible);
      if (kids.length < 3 || kids.length > 6) continue;
      // A stat is a display-size figure with a smaller label; the figures sit side by side.
      const stat = kids.filter((k) => {
        const t = text(k);
        if (t.length > 60) return false;
        const nums = [k, ...k.querySelectorAll('*')].filter((d) => NUM_ONLY.test(ownText(d) || (d.children.length === 0 ? text(d) : '')) && px(cs(d).fontSize) >= 28);
        if (!nums.length) return false;
        const labels = [...k.querySelectorAll('*')].filter((d) => ownText(d) && !nums.includes(d));
        const big = px(cs(nums[0]).fontSize);
        return t.replace(nums[0].innerText || '', '').trim().length <= 40 && labels.every((l) => px(cs(l).fontSize) * 1.4 <= big);
      });
      const tops = stat.map((k) => Math.round(k.getBoundingClientRect().top));
      const inRow = stat.length >= 3 && tops.filter((t) => Math.abs(t - tops[0]) <= 20).length >= 3;
      if (inRow && stat.length >= kids.length - 1) {
        const tiles = stat.filter(isBox).length >= 3;
        groupTaken.add(parent);
        add(tiles ? 85 : 7, parent, `${stat.length} figures in a row: ${stat.map((k) => short(text(k), 24)).join(' · ')}`);
      }
    }
    // P73 sparklines on every stat card
    if (ctx.scope.web) {
      for (const g of equalGroups) {
        const ok = g.kids.filter((k) => [...k.querySelectorAll('svg')].some((s) => { const r = s.getBoundingClientRect(); return r.height <= 80 && s.querySelector('polyline,path'); }) && /[+−-]\s?\d+(\.\d+)?\s?%/.test(text(k)));
        if (ok.length >= 3) { groupTaken.add(g.parent); add(73, g.parent, `${ok.length} stat cards each with a sparkline and a change figure`); }
      }
    }
    // P4 identical card grid / P78 perfect sameness
    for (const g of equalGroups) {
      if (groupTaken.has(g.parent) || g.parent.closest('footer,nav')) continue;
      const boxed = g.kids.every(isBox);
      const iconed = g.kids.every((k) => k.querySelector('svg,img,i[class*=icon],[class*=icon]'));
      const cardLike = (boxed || iconed) ? g.kids.filter((k) => k.querySelector(HEADING + ',strong,b') && (k.querySelector('p') || text(k).length > 30)) : [];
      const tops = g.kids.map((k) => Math.round(k.getBoundingClientRect().top));
      const sideBySide = tops.filter((t) => Math.abs(t - tops[0]) <= 8).length >= 2;
      if (sideBySide && cardLike.length >= 3 && cardLike.length === g.kids.length) {
        const lens = g.kids.map((k) => text(k).length);
        const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
        const cov = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length) / (mean || 1);
        add(4, g.parent, `${g.kids.length} cards of identical size (${Math.round(g.kids[0].getBoundingClientRect().width)}×${Math.round(g.kids[0].getBoundingClientRect().height)}px), each a heading plus short text`, { cov });
        hits[hits.length - 1].cov = cov;
      }
    }

    // P12 every button primary / P17 button pile / P22 button styles
    const buttons = els.filter(isButton);
    const btnGroups = new Map();
    for (const b of buttons) { const p = b.parentElement; if (!btnGroups.has(p)) btnGroups.set(p, []); btnGroups.get(p).push(b); }
    if (ctx.scope.web) {
      for (const [p, bs] of btnGroups) {
        if (bs.length < 2 || bs.length > 5 || p.closest('nav')) continue;
        const st = bs.map(btnStyle);
        if (st.every((s) => s.filled) && new Set(st.map((s) => s.key)).size === 1) {
          add(12, p, `${bs.length} buttons look the same (${st[0].key.split('|')[0]} fill): ${bs.map((b) => '"' + short(text(b), 20) + '"').join(', ')}`);
        }
      }
    }
    {
      const styles = new Map();
      for (const b of buttons) { if (b.closest('nav')) continue; const s = btnStyle(b); styles.set(s.key, (styles.get(s.key) || []).concat(b)); }
      const radii = new Set(buttons.filter((b) => !b.closest('nav')).map((b) => btnStyle(b).radius));
      const linkStyles = new Set(within(root, 'p a, li a').filter(visible).filter((a) => !isButton(a)).map((a) => { const s = cs(a); return hex(rgba(s.color)) + '|' + s.textDecorationLine; }));
      const cards = els.filter((e) => isBox(e) && e.querySelectorAll(TEXT_BLOCKS).length >= 2 && e.getBoundingClientRect().width >= 120);
      const cardStyles = new Set(cards.map((c) => { const s = cs(c); return Math.round(px(s.borderTopLeftRadius)) + '|' + (hasShadow(s) ? 'shadow' : 'flat') + '|' + (borderInfo(s).all ? 'border' : 'noborder'); }));
      const bits = [];
      if (styles.size >= 4) bits.push(`${styles.size} button styles`);
      else if (radii.size >= 3) bits.push(`buttons with ${radii.size} different corner radii (${[...radii].join(', ')}px)`);
      if (cardStyles.size >= 3) bits.push(`${cardStyles.size} card styles`);
      if (linkStyles.size >= 3) bits.push(`${linkStyles.size} link looks in body text`);
      if (bits.length) add(22, root, bits.join('; '), { key: 'page' });
    }

    // first screen / hero
    const h1 = within(root, 'h1').find(visible);
    const hero = h1 ? (h1.closest('header,section,[class*=hero]') || h1.parentElement) : null;
    if (ctx.scope.web && hero && root.contains(hero)) {
      const hb = buttons.filter((b) => hero.contains(b) && !b.closest('nav'));
      if (hb.length >= 3) add(17, hero, `${hb.length} buttons under the headline: ${hb.map((b) => '"' + short(text(b), 18) + '"').join(', ')}`, { key: 'buttons' });
    }
    if (ctx.scope.web) {
      const proof = els.filter((e) => {
        const t = ownText(e) || (e.children.length === 0 ? text(e) : '');
        if (!t || t.length > 120) return false;
        const m = /([★⭐]{3,})|(\b(loved|trusted|used|chosen) by\b)|(\b\d[\d,.]*\s?[kKmM]?\+?\s+(happy\s+|satisfied\s+)?(customers|users|teams|companies|developers|people|businesses|reviews)\b)|(\brated\s+\d(\.\d)?\b)/i.test(t);
        return m && !e.closest('a,cite,blockquote cite') && !e.querySelector('a,cite,sup');
      });
      if (proof.length) add(17, proof[0], `proof with no source: ${proof.slice(0, 3).map((e) => '"' + short(text(e), 40) + '"').join(', ')}`, { key: 'proof' });
    }
    // P2 pill chip above the hero headline
    if (ctx.scope.web && h1) {
      let prev = h1.previousElementSibling;
      for (let i = 0; i < 2 && prev; i++, prev = prev.previousElementSibling) {
        const cands = [prev, ...prev.querySelectorAll('*')].filter(visible);
        const pill = cands.find((c) => {
          const r = c.getBoundingClientRect(); const s = cs(c);
          return r.height <= 44 && r.height >= 14 && text(c).length > 0 && text(c).length <= 70 && px(s.borderTopLeftRadius) >= r.height / 2 - 1 && (bgOf(c) || borderInfo(s).all);
        });
        if (pill) { add(2, pill, `rounded badge "${short(text(pill), 50)}" right above the h1`); break; }
      }
    }

    // P15 cardocalypse
    {
      const blocks = within(root, TEXT_BLOCKS).filter((b) => visible(b) && text(b).length > 1);
      let boxed = 0; const boxes = new Set();
      for (const b of blocks) {
        let n = b.parentElement;
        while (n && n !== root && root.contains(n)) {
          if (isBox(n)) { if (n.querySelectorAll(TEXT_BLOCKS).length <= 3) { boxed++; boxes.add(n); } break; }
          n = n.parentElement;
        }
      }
      const minBlocks = isSlide ? 5 : 8, minBoxes = isSlide ? 4 : 6;
      // One row of cards is pattern 4; "everything boxed" needs boxes across more than one group.
      const parents = new Set([...boxes].map((b) => b.parentElement));
      if (blocks.length >= minBlocks && boxes.size >= minBoxes && parents.size >= 2 && boxed / blocks.length >= 0.6) {
        add(15, root, `${boxed} of ${blocks.length} text blocks sit in their own box (${boxes.size} boxes)`, { key: 'page' });
      }
    }

    // P16 uneven spacing
    {
      const off = new Map();
      for (const e of els) {
        const s = cs(e);
        for (const k of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginBottom', 'rowGap', 'columnGap']) {
          const v = Math.round(px(s[k]));
          if (v > 3 && v % 4 !== 0 && v < 200) { if (!off.has(v)) off.set(v, e); }
        }
      }
      if (off.size >= 4) {
        const vals = [...off.keys()].sort((a, b) => a - b);
        add(16, off.get(vals[0]), `${off.size} spacing values off a 4px scale: ${vals.slice(0, 8).join(', ')}px`, { key: 'page' });
      }
    }

    // P18 a visual on every section (web: per page; slides: rolled up in check.mjs)
    const sections = isSlide ? [] : topSections(root);
    if (!isSlide && sections.length >= 3) {
      const mediaSide = sections.map((sec) => {
        const m = [...sec.querySelectorAll('img,svg,video,canvas,picture')].filter(visible).find((x) => { const r = x.getBoundingClientRect(); return r.width >= 160 && r.height >= 120; });
        if (!m) return null;
        const r = m.getBoundingClientRect(); const sr = sec.getBoundingClientRect();
        return (r.left + r.width / 2) < (sr.left + sr.width / 2) ? 'L' : 'R';
      });
      let run = 0, best = 0, alt = 0;
      for (let i = 0; i < mediaSide.length; i++) {
        if (mediaSide[i]) { run++; if (i && mediaSide[i - 1] && mediaSide[i - 1] !== mediaSide[i]) alt++; } else run = 0;
        best = Math.max(best, run);
      }
      if (best >= 3 && alt >= 2) add(18, root, `${best} sections in a row each carry a large image, alternating sides (${mediaSide.map((x) => x || '-').join(' ')})`, { key: 'page', conf: 'review' });
    }

    // P19 the cleaned-up template
    if (ctx.scope.web && !isSlide) {
      const bg = effectiveBg(document.body); const o = oklch(bg);
      const fam = firstFamily(cs(document.body)).toLowerCase();
      if (o.L < 0.3 && o.C < 0.025 && /^(inter|system-ui|-apple-system|blinkmacsystemfont|helvetica|arial|sans-serif|segoe ui|geist)/.test(fam)) {
        const colored = els.filter((e) => { const s = cs(e); const c = rgba(s.color); const b = bgOf(e); return ((c && oklch(c).C > 0.08 && ownText(e)) || (b && oklch(b).C > 0.08)); });
        const nonBtn = colored.filter((e) => !isButton(e) && !e.closest('button,a'));
        if (colored.length >= 1 && nonBtn.length <= 1) add(19, document.body, `flat ${hex(bg)} page, ${fam} type, brand color only on ${colored.length - nonBtn.length} button(s)`, { key: 'page', conf: 'review' });
      }
    }

    // P20 dead empty space
    {
      const zones = isSlide ? [root] : sections.filter((s) => s.getBoundingClientRect().height >= 0.6 * vh);
      for (const z of zones) {
        const zr = z.getBoundingClientRect();
        // Text is measured by its own extent, not its block box, and logos are left out,
        // so a short line in a big empty slide reads as the small block it is.
        const extent = (e) => { if (e.matches('h1,h2,h3,h4,h5,h6,p,li,blockquote')) { const rg = document.createRange(); rg.selectNodeContents(e); return rg.getBoundingClientRect(); } return e.getBoundingClientRect(); };
        const isLogo = (e) => /logo/i.test((e.getAttribute('class') || '') + ' ' + (e.getAttribute('alt') || '') + ' ' + (e.getAttribute('src') || ''));
        const content = [...z.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,img,svg,video,canvas,button,a,blockquote,table,figure,input')].filter((e) => visible(e) && !isLogo(e) && !(e.closest('svg') && e.tagName !== 'svg') && !e.parentElement.closest('p,li,h1,h2,h3,h4,h5,h6,button,a,blockquote')).map(extent)
          .concat([...z.querySelectorAll('div,aside,article,figure,ul,ol')].filter((e) => e !== z && visible(e) && isBox(e) && text(e)).map((e) => e.getBoundingClientRect()))
          .filter((r) => r.width > 2 && r.height > 2);
        if (!content.length) continue;
        const L = Math.max(zr.left, Math.min(...content.map((r) => r.left))), T = Math.max(zr.top, Math.min(...content.map((r) => r.top)));
        const R = Math.min(zr.right, Math.max(...content.map((r) => r.right))), B = Math.min(zr.bottom, Math.max(...content.map((r) => r.bottom)));
        const share = Math.max(0, R - L) * Math.max(0, B - T) / (zr.width * zr.height);
        if (share < (isSlide ? 0.06 : 0.08)) add(20, z, `content fills ${Math.round(share * 100)}% of a ${Math.round(zr.width)}×${Math.round(zr.height)}px ${isSlide ? 'slide' : 'section'}`);
      }
    }

    // P21 tilted / staggered
    {
      const tilted = els.filter((e) => {
        const t = cs(e).transform; if (!t || t === 'none') return false;
        const m = t.match(/matrix\(([^)]+)\)/); if (!m) return false;
        const [a, b] = m[1].split(',').map(Number);
        const deg = Math.abs(Math.atan2(b, a) * 180 / Math.PI);
        const r = e.getBoundingClientRect();
        return deg >= 1 && deg <= 45 && r.width >= 60 && r.height >= 40;
      });
      if (tilted.length) add(21, tilted[0], `${tilted.length} box(es) rotated: ${tilted.slice(0, 3).map(cssPath).join(', ')}`, { key: 'tilt' });
      let overlaps = 0; let first = null;
      for (const parent of new Set(els.map((e) => e.parentElement))) {
        if (!parent) continue;
        const kids = [...parent.children].filter((k) => visible(k) && isBox(k) && text(k).length > 0);
        for (let i = 1; i < kids.length; i++) {
          const a = kids[i - 1].getBoundingClientRect(), b = kids[i].getBoundingClientRect();
          const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)), iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
          if (ix * iy > 0.15 * Math.min(a.width * a.height, b.width * b.height)) { overlaps++; first = first || kids[i]; }
        }
      }
      if (overlaps) add(21, first, `${overlaps} card(s) overlap the card next to them`, { key: 'overlap' });
    }

    // P25 one accented word / P84 italic serif flourish
    for (const h of within(root, HEADING).filter(visible)) {
      const hs = cs(h); const ht = text(h);
      for (const c of h.querySelectorAll('span,em,i,mark,strong,b')) {
        const t = text(c); if (!t || t === ht || t.split(/\s+/).length > 4 || !visible(c)) continue;
        const s = cs(c);
        const italicSerif = s.fontStyle === 'italic' && isSerif(s) && !isSerif(hs);
        if (italicSerif) { add(84, h, `"${short(t, 30)}" set in italic serif inside a sans heading "${short(ht, 50)}"`); break; }
        const diff = [];
        if (rgba(s.color).a > 0.1 && dE(rgba(s.color), rgba(hs.color)) > 0.08) diff.push('color ' + hex(rgba(s.color)));
        if (s.fontStyle !== hs.fontStyle) diff.push(s.fontStyle);
        if (bgOf(c)) diff.push('highlight ' + hex(bgOf(c)));
        else if (/gradient\(/.test(s.backgroundImage) && !/text/.test(s.backgroundClip || s.webkitBackgroundClip || '')) diff.push('highlighter gradient');
        if (/text/.test(s.backgroundClip || s.webkitBackgroundClip || '')) diff.push('gradient fill');
        if (firstFamily(s) !== firstFamily(hs)) diff.push('font ' + firstFamily(s));
        if (diff.length) { add(25, h, `"${short(t, 30)}" in "${short(ht, 50)}" is set apart (${diff.join(', ')})`); break; }
      }
    }

    // P26 monospace as costume
    if (ctx.scope.web) {
      const mono = els.filter((e) => ownText(e).length > 1 && MONO.test(firstFamily(cs(e))) && !e.closest('code,pre,kbd,samp,var,tt'));
      if (mono.length) add(26, mono[0], `${mono.length} text element(s) in ${firstFamily(cs(mono[0]))} outside code: ${mono.slice(0, 3).map((e) => '"' + short(text(e), 24) + '"').join(', ')}`, { key: 'page' });
    }

    // P28 crushed letter spacing (fallback for impeccable's rule)
    {
      const crushed = els.filter((e) => { const s = cs(e); const fs = px(s.fontSize); return ownText(e) && fs >= 20 && s.letterSpacing !== 'normal' && px(s.letterSpacing) / fs <= -0.045; });
      if (crushed.length) add(28, crushed[0], `letter-spacing ${cs(crushed[0]).letterSpacing} at ${cs(crushed[0]).fontSize} (${(px(cs(crushed[0]).letterSpacing) / px(cs(crushed[0]).fontSize)).toFixed(3)}em)`, { key: 'page' });
    }
    // P30 heading weights
    {
      const hs = within(root, 'h1,h2,h3').filter(visible);
      const heavy = hs.filter((h) => px(cs(h).fontWeight) >= 800);
      if (heavy.length >= 2 && heavy.length >= hs.length / 2) add(30, heavy[0], `${heavy.length} of ${hs.length} headings at weight ${[...new Set(heavy.map((h) => cs(h).fontWeight))].join('/')}`, { key: 'page' });
    }

    // P31 too many sizes and weights
    {
      const tx = els.filter((e) => ownText(e).length > 0);
      const sizes = new Set(tx.map((e) => Math.round(px(cs(e).fontSize))));
      const weights = new Set(tx.map((e) => cs(e).fontWeight));
      const lim = isSlide ? { s: 7, w: 4 } : { s: 11, w: 5 };
      let flagged = false;
      if (sizes.size >= lim.s || weights.size >= lim.w) { add(31, root, `${sizes.size} font sizes (${[...sizes].sort((a, b) => a - b).join(', ')}px) and ${weights.size} weights on one ${isSlide ? 'slide' : 'page'}`, { key: 'page' }); flagged = true; }
      if (!flagged) for (const box of els.filter((e) => isBox(e) && e.querySelectorAll('*').length < 80)) {
        const t2 = [...box.querySelectorAll('*')].filter((e) => visible(e) && ownText(e).length > 0);
        const s2 = new Set(t2.map((e) => Math.round(px(cs(e).fontSize)))); const w2 = new Set(t2.map((e) => cs(e).fontWeight));
        if (s2.size >= 6 || w2.size >= 4) { add(31, box, `${s2.size} font sizes and ${w2.size} weights inside one panel`); break; }
      }
    }

    // colour facts used by 36, 43, 44, 45, 46
    const pageBg = effectiveBg(isSlide ? root : document.body);
    const pageDark = oklch(pageBg).L < 0.3;
    const neon = (c) => { if (!c || c.a < 0.3) return false; const o = oklch(c); return o.C >= 0.14 && o.L >= 0.6 && ((o.h >= 100 && o.h <= 235) || (o.h >= 15 && o.h <= 50) || (o.h >= 320 || o.h <= 10)); };
    if (pageDark) {
      // P36 dark neon
      const neonEls = els.filter((e) => { const s = cs(e); return (ownText(e) && neon(rgba(s.color))) || neon(bgOf(e)) || (borderInfo(s).any && neon(rgba(s.borderTopColor))); });
      if (neonEls.length >= 2) {
        const cols = [...new Set(neonEls.map((e) => { const s = cs(e); return hex(neon(rgba(s.color)) ? rgba(s.color) : neon(bgOf(e)) ? bgOf(e) : rgba(s.borderTopColor)); }))].slice(0, 3);
        add(36, isSlide ? root : document.body, `near-black ${hex(pageBg)} page with neon accent ${cols.join(', ')} on ${neonEls.length} elements`, { key: 'page' });
      }
      // P43 neon borders
      const nb = els.filter((e) => { const s = cs(e); const b = borderInfo(s); const r = e.getBoundingClientRect(); return b.any && r.width >= 40 && r.height >= 24 && b.sides.some((x) => x.w >= 1 && x.style !== 'none' && neon(x.c)) && oklch(effectiveBg(e)).L < 0.3; });
      if (nb.length) add(43, nb[0], `${nb.length} element(s) outlined in bright ${hex(borderInfo(cs(nb[0])).sides.find((x) => neon(x.c)).c)} on a dark surface`, { key: 'page' });
    }
    // P44 five lavenders
    {
      const cols = [...new Set(els.filter((e) => ownText(e)).map((e) => cs(e).color))].map(rgba).filter((c) => c && oklch(c).C >= 0.04);
      for (const c of cols) {
        const near = cols.filter((d) => hueDiff(oklch(c).h, oklch(d).h) <= 20);
        const distinct = near.filter((d, i) => near.findIndex((x) => dE(x, d) < 0.02) === i);
        if (distinct.length >= 4) { add(44, root, `${distinct.length} text colors in one hue: ${distinct.slice(0, 6).map(hex).join(', ')}`, { key: 'page' }); break; }
      }
    }
    // P45 everything highlighted
    {
      const tally = new Map();
      const bump = (c, role) => { if (!c || c.a < 0.3 || oklch(c).C < 0.1) return; const k = hex(c); if (!tally.has(k)) tally.set(k, { n: 0, roles: new Set() }); const t = tally.get(k); t.n++; t.roles.add(role); };
      for (const e of els) {
        const s = cs(e);
        if (e.tagName === 'svg' || e.closest('svg')) { bump(rgba(s.fill), 'icons'); bump(rgba(s.stroke), 'icons'); }
        else if (e.tagName === 'A' && !isButton(e)) bump(rgba(s.color), 'links');
        else if (ownText(e) && e.closest(HEADING)) bump(rgba(s.color), 'heading text');
        else if (ownText(e) && !isButton(e) && px(s.fontSize) <= 14) bump(rgba(s.color), 'labels');
        { const b = borderInfo(s); for (const side of b.sides) if (side.w >= 1 && side.style !== 'none') bump(side.c, 'borders'); }
        if (!isButton(e) && bgOf(e) && ownText(e) && e.getBoundingClientRect().height <= 40) bump(bgOf(e), 'tags');
        if (e.tagName === 'HR') bump(rgba(s.borderTopColor), 'rules');
        if (isButton(e)) bump(bgOf(e), 'buttons');
      }
      const top = [...tally.entries()].sort((a, b) => b[1].roles.size - a[1].roles.size || b[1].n - a[1].n)[0];
      if (top && top[1].roles.size >= 4) add(45, root, `accent ${top[0]} used for ${[...top[1].roles].join(', ')}`, { key: 'page', conf: 'review' });
    }
    // P46 near-black on near-black
    {
      // Only dark boxes sitting on another dark surface count: separate dark
      // blocks on a light page are not "near-black on near-black".
      const nested = els.filter(isBox).filter((e) => { const b = bgOf(e); if (!b || oklch(b).L >= 0.25) return false; const under = effectiveBg(e.parentElement || e); return oklch(under).L < 0.25 && hex(under) !== hex(b) && Math.abs(oklch(under).L - oklch(b).L) < 0.06; });
      const uniq = [...new Set(nested.flatMap((e) => [hex(bgOf(e)), hex(effectiveBg(e.parentElement))]))];
      const Ls = uniq.map((h) => oklch(rgba(h)).L);
      const darkText = els.filter((e) => ownText(e) && oklch(effectiveBg(e)).L < 0.25 && contrast(rgba(cs(e).color), effectiveBg(e)) < 3);
      if (nested.length >= 2 && uniq.length >= 3 && Math.max(...Ls) - Math.min(...Ls) < 0.08) add(46, nested[0], `${uniq.length} near-identical dark surfaces: ${uniq.slice(0, 5).join(', ')}`, { key: 'surfaces' });
      if (darkText.length) add(46, darkText[0], `${darkText.length} text element(s) under 3:1 contrast on a dark surface (e.g. ${hex(rgba(cs(darkText[0]).color))} on ${hex(effectiveBg(darkText[0]))})`, { key: 'darktext' });
    }

    // P33 purple-to-blue gradient (fallback for impeccable's rule)
    {
      const grads = (isSlide ? [root, ...els] : els).filter((e) => /gradient\(/.test(cs(e).backgroundImage)).map((e) => {
        const stops = (cs(e).backgroundImage.match(/rgba?\([^)]*\)|oklch\([^)]*\)|#[0-9a-f]{3,8}/gi) || []).map(rgba).filter((c) => c && c.a > 0.3).map(oklch).filter((o) => o.C >= 0.1);
        return { e, stops };
      }).filter(({ stops }) => stops.length >= 2 && stops.every((o) => o.h >= 250 && o.h <= 330) && Math.max(...stops.map((o) => o.h)) - Math.min(...stops.map((o) => o.h)) >= 12);
      if (grads.length) add(33, grads[0].e, `${grads.length} purple-to-blue gradient background(s): ${short(cs(grads[0].e).backgroundImage, 90)}`, { key: 'page' });
    }
    // Fallbacks for impeccable rules that miss some forms (check.mjs drops these when impeccable reports the pattern).
    {
      // P11 oversized hero headline
      const h = within(root, 'h1').filter(visible)[0];
      if (h) { const words = text(h).split(/\s+/).length, fs = px(cs(h).fontSize); if (words >= 8 && fs >= (isSlide ? Math.max(64, rootRect.height * 0.085) : 64)) add(11, h, `${words}-word h1 at ${Math.round(fs)}px`, { key: 'fb' }); }
      // P38 side stripe (border-left, border-right or logical border-inline-start/end)
      const stripe = els.filter((e) => { const b = borderInfo(cs(e)).sides; const r = e.getBoundingClientRect(); const sideW = Math.max(b[1].w, b[3].w); const side = b[3].w >= b[1].w ? b[3] : b[1]; return r.width >= 80 && r.height >= 40 && sideW >= 3 && side.style !== 'none' && side.c && side.c.a > 0.3 && oklch(side.c).C >= 0.05 && b[0].w <= 1 && b[2].w <= 1; });
      if (stripe.length) add(38, stripe[0], `${stripe.length} box(es) with a thick colored edge stripe (${Math.max(px(cs(stripe[0]).borderLeftWidth), px(cs(stripe[0]).borderRightWidth))}px)`, { key: 'fb' });
      // P40 decorative grid and stripes: tiled gradients
      const tiled = (isSlide ? [root, ...els] : els).filter((e) => { const s = cs(e); if (!/gradient\(/.test(s.backgroundImage)) return false; if (/repeating-(linear|radial)-gradient/.test(s.backgroundImage)) return true; const sz = (s.backgroundSize.match(/[\d.]+px/g) || []).map(px); return sz.length && Math.max(...sz) <= 80; });
      if (tiled.length) add(40, tiled[0], `tiled gradient background (background-size ${cs(tiled[0]).backgroundSize})`, { key: 'fb' });
      // P49 hard offset shadow, as box-shadow or filter: drop-shadow
      const hard = els.filter((e) => { const s = cs(e); const drops = (s.filter.match(/drop-shadow\((?:[^()]|\([^()]*\))*\)/g) || []).map((d) => d.slice(12, -1));
        const layers = [...s.boxShadow.split(/,(?![^(]*\))/), ...drops]; return layers.some((l) => { if (/inset|none/.test(l)) return false; const n = (l.replace(/rgba?\([^)]*\)|#[0-9a-f]+/gi, '').match(/-?[\d.]+px/g) || []).map(px); return n.length >= 3 && n[2] === 0 && Math.max(Math.abs(n[0]), Math.abs(n[1])) >= 3; }); });
      if (hard.length) add(49, hard[0], `hard block shadow with no blur on ${hard.length} element(s)`, { key: 'fb' });
      // P5 icon tile above the heading
      function isTileLike(t) { const r = t.getBoundingClientRect(); return r.width >= 28 && r.width <= 72 && Math.abs(r.width - r.height) <= 6 && !!bgOf(t); }
      const tiles = within(root, HEADING).filter(visible).map((h) => h.previousElementSibling).map((t) => (t && t.children.length <= 2 && !isTileLike(t) ? [...t.children].find(isTileLike) || t : t)).filter((t) => {
        if (!t || !visible(t)) return false;
        const r = t.getBoundingClientRect();
        return r.width >= 28 && r.width <= 72 && Math.abs(r.width - r.height) <= 6 && bgOf(t) && px(cs(t).borderTopLeftRadius) >= 4 && (t.querySelector('svg,img,i') || EMOJI.test(text(t)) || pseudoText(t, '::before'));
      });
      if (tiles.length >= 2) add(5, tiles[0], `${tiles.length} tinted icon tiles stacked above headings`, { key: 'fb' });
      // P8 fake sequence numbers drawn with CSS counters
      const counted = els.filter((e) => /counter\(/.test(getComputedStyle(e, '::before').content + getComputedStyle(e, '::after').content) && (e.matches(HEADING + ',section,article') || e.querySelector(HEADING)));
      if (counted.length >= 3) add(8, counted[0], `${counted.length} sections or headings numbered with a CSS counter`, { key: 'fb', conf: 'review' });
      // P6 nested cards: a bordered or shadowed box inside another, inside a third
      const framed = (e) => { const s = cs(e); return isBox(e) && (borderInfo(s).all || hasShadow(s)); };
      const nest = els.filter((e) => { if (!framed(e)) return false; let n = e.parentElement, depth = 0; while (n && n !== document.body && depth < 2) { if (framed(n)) depth++; n = n.parentElement; } return depth >= 2; });
      if (nest.length) add(6, nest[0], `card three levels deep: ${cssPath(nest[0])}`, { key: 'fb' });
      // P47 shadows on everything: repeated cards with a hairline border and a wide soft shadow
      const thin = els.filter((e) => { const s = cs(e); if (!borderInfo(s).all || px(s.borderTopWidth) > 1.5 || !hasShadow(s)) return false; const n = (s.boxShadow.replace(/rgba?\([^)]*\)|#[0-9a-f]+/gi, '').match(/-?[\d.]+px/g) || []).map(px); return (n[2] || 0) >= 16; });
      if (thin.length >= 3) add(47, thin[0], `${thin.length} cards with a 1px border plus a wide soft shadow`, { key: 'fb' });
    }
    // P37 glassmorphism
    {
      const glass = els.filter((e) => { const s = cs(e); const f = s.backdropFilter || s.webkitBackdropFilter || ''; const b = rgba(s.backgroundColor); return /blur\(/.test(f) && px(f.match(/blur\(([^)]+)\)/)[1]) >= 4 && b && b.a > 0 && b.a < 0.9; });
      if (glass.length) add(37, glass[0], `${glass.length} frosted panel(s) (backdrop-filter: ${cs(glass[0]).backdropFilter})`, { key: 'page' });
    }
    // P39 rounding everywhere
    {
      // Empty boxes (chart bars, blobs) are marks, not containers, so they are left out.
      const shapes = els.filter((e) => ((isBox(e) && (e.children.length || ownText(e))) || isButton(e) || /^(IMG|INPUT|TEXTAREA|SELECT)$/.test(e.tagName)) && e.getBoundingClientRect().width < rootRect.width * 0.9);
      const round = shapes.filter((e) => { const r = e.getBoundingClientRect(); const rad = px(cs(e).borderTopLeftRadius); return rad >= 12 || rad >= Math.min(r.width, r.height) / 2 - 1; });
      if (shapes.length >= 6 && round.length / shapes.length >= 0.8) add(39, root, `${round.length} of ${shapes.length} boxes, buttons and images have 12px+ or pill corners`, { key: 'page' });
    }
    // P41 untouched component-library look
    if (ctx.scope.web && !isSlide) {
      const rs = cs(document.documentElement);
      const tokens = ['--radius', '--primary', '--primary-foreground', '--muted-foreground', '--ring', '--card-foreground', '--popover', '--accent-foreground', '--destructive'].filter((v) => rs.getPropertyValue(v).trim());
      const slots = document.querySelectorAll('[data-slot]').length;
      if (tokens.length >= 4 || slots >= 3) add(41, document.documentElement, `component-library defaults: ${tokens.length} shadcn/ui tokens (${tokens.slice(0, 5).join(', ')})${slots ? `, ${slots} data-slot elements` : ''}`, { key: 'page' });
    }
    // P50 giant shadows
    {
      const big = els.filter((e) => {
        const sh = cs(e).boxShadow; if (!sh || sh === 'none') return false;
        return sh.split(/,(?![^(]*\))/).some((layer) => {
          if (/inset/.test(layer)) return false;
          const nums = (layer.replace(/rgba?\([^)]*\)|oklch\([^)]*\)|#[0-9a-f]+/gi, '').match(/-?[\d.]+px/g) || []).map(px);
          const c = rgba((layer.match(/rgba?\([^)]*\)|oklch\([^)]*\)|#[0-9a-f]{3,8}/i) || ['#000'])[0]);
          return ((nums[2] || 0) >= 40 || (nums[3] || 0) >= 16) && c && c.a >= 0.12;
        });
      });
      if (big.length) add(50, big[0], `${big.length} element(s) with a shadow blur of 40px or more (${short(cs(big[0]).boxShadow, 60)})`, { key: 'page' });
    }
    // P51 emoji as icons / P52 sparkle
    {
      const spots = els.filter((e) => e.matches('nav a, nav li, li, button, a, h2, h3, h4, h5, span, div, i') && ownText(e));
      const emo = spots.filter((e) => { const t = ownText(e); const m = t.match(EMOJI); return m && !SPARKLE.test(m[0]) && (t.length <= 3 || t.search(EMOJI) === 0); });
      for (const e of els) { const t = pseudoText(e, '::before') || pseudoText(e, '::after'); const m = t && t.match(EMOJI); if (m && !SPARKLE.test(m[0]) && t.length <= 4) emo.push(e); }
      const emoOf = (e) => ((ownText(e).match(EMOJI) || (pseudoText(e, '::before') + pseudoText(e, '::after')).match(EMOJI) || [''])[0]);
      if (emo.length >= 2) add(51, emo[0], `${emo.length} emoji used as icons: ${[...new Set(emo.map(emoOf))].slice(0, 8).join(' ')}`, { key: 'page' });
      const pseudo = (e) => ['::before', '::after'].map((p) => getComputedStyle(e, p).content).filter((c) => c && c !== 'none' && c !== 'normal').join(' ');
      const sp = els.filter((e) => SPARKLE.test(ownText(e)) || SPARKLE.test(pseudo(e)) || /sparkle/i.test((e.getAttribute('class') || '') + ' ' + (e.id || '') + ' ' + (e.getAttribute('data-icon') || '') + ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('href') || '')));
      if (sp.length) add(52, sp[0], `${sp.length} sparkle mark(s) for AI features, e.g. "${short(text(sp[0]) || cssPath(sp[0]), 40)}"`, { key: 'page' });
    }
    // P53 placeholder images and initials / P68 letter in a circle
    {
      const PH = /(placehold|placeholder|dummyimage|picsum|lorempixel|fakeimg|unsplash\.it|source\.unsplash|via\.placeholder)/i;
      const imgs = within(root, 'img').filter((i) => { const r = i.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      const ph = imgs.filter((i) => !i.getAttribute('src') || PH.test(i.getAttribute('src')) || PH.test(i.alt || ''));
      if (ph.length) add(53, ph[0], `${ph.length} placeholder image(s): ${ph.slice(0, 3).map((i) => i.getAttribute('src') || '(empty src)').join(', ')}`, { key: 'img' });
      // Letters drawn with ::before / ::after (for example content: attr(data-mark)) count too.
      const circleOf = (e, pe) => { const st = getComputedStyle(e, pe); const w = px(st.width); const c = pseudoText(e, pe); return w >= 20 && w <= 96 && Math.abs(w - px(st.height)) <= w * 0.1 && px(st.borderTopLeftRadius) >= w * 0.45 && /^[A-Z]{1,2}$/.test(c) && rgba(st.backgroundColor).a > 0.05 ? c : null; };
      const selfCircle = (e) => { const r = e.getBoundingClientRect(); if (text(e) || r.width < 20 || r.width > 96 || Math.abs(r.width - r.height) > r.width * 0.1 || px(cs(e).borderTopLeftRadius) < r.width * 0.45 || !(bgOf(e) || borderInfo(cs(e)).all)) return null; const c = (pseudoText(e, '::before') || pseudoText(e, '::after')).trim(); return /^[A-Z]{1,2}$/.test(c) ? c : null; };
      const pseudoLetters = els.map((e) => ({ e, c: circleOf(e, '::before') || circleOf(e, '::after') || selfCircle(e) })).filter((x) => x.c);
      const circles = els.filter((e) => { const r = e.getBoundingClientRect(); const t = text(e); return r.width >= 20 && r.width <= 96 && Math.abs(r.width - r.height) <= r.width * 0.1 && px(cs(e).borderTopLeftRadius) >= r.width * 0.45 && /^[A-Z]{1,2}$/.test(t) && (bgOf(e) || borderInfo(cs(e)).all); });
      const initials = [...circles.filter((e) => text(e).length === 2).map((e) => ({ e, c: text(e) })), ...pseudoLetters.filter((x) => x.c.length === 2)];
      const letters = circles.filter((e) => text(e).length === 1);
      pseudoLetters.splice(0, pseudoLetters.length, ...pseudoLetters.filter((x) => x.c.length === 1));
      if (initials.length) add(53, initials[0].e, `${initials.length} initials avatar(s) instead of photos: ${initials.slice(0, 4).map((x) => x.c).join(', ')}`, { key: 'initials' });
      if (letters.length || pseudoLetters.length >= 2) {
        const all = [...letters.map((e) => ({ e, c: text(e) })), ...pseudoLetters];
        add(68, all[0].e, `${all.length} letter-in-a-circle icon(s): ${all.slice(0, 6).map((x) => x.c).join(', ')}`, { key: 'page' });
      }
    }
    // P54 fake window chrome
    if (ctx.scope.web) {
      for (const parent of new Set(els.map((e) => e.parentElement))) {
        if (!parent) continue;
        const dots = [...parent.children].filter((k) => { const r = k.getBoundingClientRect(); return visible(k) && r.width >= 6 && r.width <= 18 && Math.abs(r.width - r.height) < 2 && px(cs(k).borderTopLeftRadius) >= r.width / 2 - 1 && bgOf(k); });
        if (dots.length === 3) {
          const hs = dots.map((d) => oklch(bgOf(d)).h);
          if (hs[0] < 45 || hs[0] > 330) if (hs[1] > 60 && hs[1] < 120 && hs[2] > 120 && hs[2] < 170) { add(54, parent, 'red, yellow and green window dots on a drawn window', { key: 'chrome' }); break; }
        }
      }
    }
    // P56 same motion / P60 fly-in / P61 floating loops
    if (ctx.scope.web && !isSlide && ctx.motion !== 'skip') motionChecks(root, els, sections, add);
    // P57 bounce and elastic easing (fallback for impeccable's rule)
    if (ctx.scope.web && !isSlide) {
      const css = allCss() || '';
      const bez = [...css.matchAll(/cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/g)].find((m) => +m[2] < 0 || +m[2] > 1 || +m[4] < 0 || +m[4] > 1);
      const named = css.match(/@keyframes\s+([\w-]*(bounce|elastic|wobble|jelly|rubber|spring)[\w-]*)/i);
      if (bez || named) add(57, root, bez ? `overshooting easing ${bez[0]}` : `springy keyframes "${named[1]}"`, { key: 'page' });
    }
    // P59 unthemed browser defaults
    if (ctx.scope.web && !isSlide) {
      const css = allCss();
      if (cssComplete) {
        const have = { selection: /::selection/.test(css), focus: /:focus-visible|:focus\s*\{[^}]*(outline|box-shadow)/.test(css), scrollbar: /scrollbar-color|::-webkit-scrollbar/.test(css), accent: /accent-color/.test(css) };
        const missing = Object.keys(have).filter((k) => !have[k]);
        if (missing.length === 4 && document.querySelector('a[href],input,button')) add(59, document.documentElement, `no ::selection, :focus-visible, scrollbar or accent-color styles in the CSS`, { key: 'page' });
      }
    }
    // P65 image that doesn't blend
    for (const img of within(root, 'img').filter(visible)) {
      const r = img.getBoundingClientRect();
      if (r.width < 200 || r.height < 120 || !img.complete || !img.naturalWidth) continue;
      try {
        const c = document.createElement('canvas'); c.width = 48; c.height = 48;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0, 48, 48);
        const d = g.getImageData(0, 0, 48, 48).data; const edge = [];
        for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) if (x < 2 || y < 2 || x > 45 || y > 45) { const i = (y * 48 + x) * 4; if (d[i + 3] > 200) edge.push([d[i], d[i + 1], d[i + 2]]); }
        if (edge.length < 100) continue;
        const mean = [0, 1, 2].map((k) => edge.reduce((a, p) => a + p[k], 0) / edge.length);
        const sd = Math.sqrt(edge.reduce((a, p) => a + (p[0] - mean[0]) ** 2 + (p[1] - mean[1]) ** 2 + (p[2] - mean[2]) ** 2, 0) / edge.length / 3);
        const em = { r: Math.round(mean[0]), g: Math.round(mean[1]), b: Math.round(mean[2]), a: 1 };
        const bg = effectiveBg(img.parentElement);
        if (sd < 14 && dE(em, bg) > 0.2) add(65, img, `image edge is a flat ${hex(em)} on a ${hex(bg)} background`);
      } catch { /* cross-origin image */ }
    }
    // P66 captions and disclaimers
    {
      const CAP = /(illustrat|for (illustration|example|demonstration) purposes|examples? only|sample image|ai[- ]generated|not (an )?(actual|real)|for reference only|^figure \d|^image:|^pictured)/i;
      const caps = [...new Set([...within(root, 'figcaption'), ...within(root, 'img,figure,picture').map((i) => i.nextElementSibling).filter(Boolean)])].filter((c) => visible(c) && text(c).length <= 160 && CAP.test(text(c)));
      if (caps.length) add(66, caps[0], `${caps.length} caption(s) that label or excuse the image: "${short(text(caps[0]), 60)}"`, { key: 'page' });
    }
    // P67 carousels
    if (ctx.scope.web) {
      const car = within(root, '[class*=swiper],[class*=slick],[class*=splide],[class*=glide],[class*=owl-],[class*=keen-slider],[class*=flickity],[class*=carousel],[aria-roledescription=carousel]').filter((e) => !e.parentElement.closest('[class*=swiper],[class*=slick],[class*=splide],[class*=carousel],[aria-roledescription=carousel]'));
      if (car.length) add(67, car[0], `carousel markup: ${cssPath(car[0])}`, { key: 'page' });
    }
    // P70 glowing pills / P71 badge spam
    if (ctx.scope.web) {
      const pills = els.filter((e) => { const r = e.getBoundingClientRect(); return r.height >= 12 && r.height <= 36 && r.width <= 220 && px(cs(e).borderTopLeftRadius) >= r.height / 2 - 1 && text(e).length > 0 && text(e).length <= 24; });
      const glowing = pills.filter((e) => { const sh = cs(e).boxShadow + ' ' + cs(e).textShadow; const m = sh.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}/gi) || []; return m.some((c) => { const x = rgba(c); return x && x.a > 0.2 && oklch(x).C >= 0.08; }) && !/^none none$/.test(sh); });
      if (glowing.length >= 2) add(70, glowing[0], `${glowing.length} pills with a colored glow: ${glowing.slice(0, 4).map((e) => '"' + text(e) + '"').join(', ')}`, { key: 'page' });
      const BADGE = /^(new|beta|pro|hot|soon|alpha|free|ai|plus|premium|preview|trending|popular|\d{1,3}\+?)$/i;
      for (const box of within(root, 'nav,aside,ul,ol,[role=navigation],[class*=sidebar],[class*=menu]').filter(visible)) {
        const badges = [...box.querySelectorAll('span,small,em,b,mark,sup')].filter((b) => visible(b) && BADGE.test(text(b)) && b.getBoundingClientRect().height <= 26 && (bgOf(b) || borderInfo(cs(b)).all));
        if (badges.length >= 3) { add(71, box, `${badges.length} badges in one list: ${badges.slice(0, 6).map(text).join(', ')}`); break; }
      }
    }
    // P72 rainbow chart
    {
      const groups = [];
      for (const svg of within(root, 'svg').filter(visible)) {
        const byParent = new Map();
        for (const r of svg.querySelectorAll('rect,path,circle')) { const p = r.parentElement; byParent.set(p, (byParent.get(p) || []).concat(r)); }
        for (const [, list] of byParent) if (list.length >= 4) groups.push(list.map((r) => cs(r).fill));
      }
      for (const parent of new Set(els.map((e) => e.parentElement))) {
        if (!parent) continue;
        const kids = [...parent.children].filter((k) => visible(k) && !text(k) && bgOf(k));
        if (kids.length < 4) continue;
        const ws = kids.map((k) => Math.round(k.getBoundingClientRect().width)); const hs = kids.map((k) => Math.round(k.getBoundingClientRect().height));
        if (Math.max(...ws) - Math.min(...ws) <= 4 && new Set(hs).size >= 3) groups.push(kids.map((k) => cs(k).backgroundColor));
      }
      for (const fills of groups) {
        const sat = [...new Set(fills.map(rgba).filter((c) => c && c.a > 0.2 && oklch(c).C >= 0.06).map(hex))];
        if (sat.length >= 4 && sat.length >= fills.length * 0.8) { add(72, root, `one series drawn in ${sat.length} colors: ${sat.slice(0, 6).join(', ')}`, { key: 'page' }); break; }
      }
    }
    // P76 mismatched icons
    {
      const icons = [...within(root, 'svg'), ...within(root, 'i[class*=fa-],span[class*=icon],i[class*=icon],img[src$=".svg"]').filter((i) => !i.querySelector('svg,img'))].filter((i) => { if (!visible(i) || (i.tagName === 'svg' && i.parentElement.closest('svg'))) return false; const r = i.getBoundingClientRect(); return r.width >= 10 && r.width <= 48 && r.height <= 48; });
      const seen = new Set();
      for (const ic of icons) {
        let g = ic.parentElement, depth = 0;
        while (g && depth < 5 && icons.filter((x) => g.contains(x)).length < 3) { g = g.parentElement; depth++; }
        if (!g || seen.has(g) || depth >= 5 || /^(BODY|MAIN|HTML)$/.test(g.tagName) || g === root) continue;
        seen.add(g);
        const set = icons.filter((x) => g.contains(x));
        if (set.length < 3) continue;
        const sizes = set.map((x) => Math.round(x.getBoundingClientRect().width));
        const sw = new Set(set.filter((x) => x.tagName === 'svg').map((x) => { const p = x.querySelector('[stroke-width]'); return x.getAttribute('stroke-width') || (p && p.getAttribute('stroke-width')) || ''; }).filter(Boolean));
        const mode = new Set(set.filter((x) => x.tagName === 'svg').map((x) => { const s = cs(x.querySelector('path,circle,rect,polyline,line') || x); const f = rgba(s.fill), st = s.stroke !== 'none' && rgba(s.stroke) && rgba(s.stroke).a > 0; return st && (!f || f.a === 0) ? 'outline' : 'filled'; }));
        const colors = new Set(set.map((x) => { const s = cs(x.querySelector('path,circle,rect') || x); const c = rgba(s.stroke !== 'none' ? s.stroke : s.fill) || rgba(s.color); return c && oklch(c).C >= 0.05 ? hex(c) : 'neutral'; }));
        const bits = [];
        if (Math.max(...sizes) > Math.min(...sizes) * 1.2) bits.push(`sizes ${[...new Set(sizes)].join('/')}px`);
        if (sw.size > 1) bits.push(`stroke widths ${[...sw].join('/')}`);
        if (mode.size > 1) bits.push('filled and outlined mixed');
        if (colors.size >= 3) bits.push(`${colors.size} colors`);
        if (bits.length) { add(76, g, `${set.length} icons in one set differ: ${bits.join(', ')}`); break; }
      }
    }
    // P82 production slips (placeholder text, off-slide text)
    {
      const PLACE = /(lorem ipsum|click to add|\b(title|subtitle|heading|headline|text|caption|name|tagline|description|quote) goes here\b|\badd (your |a )?(title|text|subtitle)\b|\[insert|insert (chart|image|logo|text|graph|photo) here|\bTODO\b|\bTBD\b|\bXXX\b|\{\{[^}]*\}\}|placeholder text|your (logo|text|headline) here|sample text)/i;
      const ph = els.filter((e) => PLACE.test(ownText(e)));
      if (ph.length) add(82, ph[0], `placeholder text left in: "${short(ownText(ph[0]), 50)}"`, { key: 'placeholder' });
      if (isSlide) {
        const out = els.filter((e) => ownText(e) && (() => { const r = e.getBoundingClientRect(); return r.right > rootRect.right + 4 || r.bottom > rootRect.bottom + 4; })());
        if (out.length) add(82, out[0], `${out.length} text element(s) run past the slide edge`, { key: 'overflow' });
      }
    }
    // P83 takeaway banner
    if (isSlide) {
      const tk = els.filter((e) => isBox(e) && e.getBoundingClientRect().top > rootRect.top + rootRect.height * 0.6 && /^\s*(key\s+)?(takeaway|insight)s?\b|^\s*(the\s+)?bottom line|^\s*why it matters|^\s*so what/i.test(text(e)));
      if (tk.length) add(83, tk[0], `boxed banner at the bottom: "${short(text(tk[0]), 60)}"`);
    }
    // P87 centered everything
    {
      const blocks = within(root, 'p,li,h1,h2,h3,h4,h5,h6,blockquote').filter((b) => visible(b) && text(b).length > 2);
      const body = blocks.filter((b) => b.matches('p,li'));
      const centered = blocks.filter((b) => cs(b).textAlign === 'center' || (b.matches('li') && cs(b.parentElement).textAlign === 'center'));
      const centeredBody = body.filter((b) => centered.includes(b));
      if (isSlide ? (blocks.length >= 3 && body.length >= 1 && centered.length / blocks.length >= 0.85 && centeredBody.length >= 1) : (body.length >= 6 && centeredBody.length / body.length >= 0.75)) {
        add(87, root, `${centered.length} of ${blocks.length} text blocks centered, body text included`, { key: 'page' });
      }
    }
    return hits;
  }

  function topSections(root) {
    const main = root.querySelector('main') || root;
    let list = [...main.children].filter((c) => visible(c) && /^(SECTION|DIV|HEADER|FOOTER|ARTICLE|ASIDE)$/.test(c.tagName) && c.getBoundingClientRect().height >= 120);
    if (list.length === 1 && list[0].children.length >= 3) list = [...list[0].children].filter((c) => visible(c) && c.getBoundingClientRect().height >= 120);
    return list;
  }

  // The page's own CSS, without the styles this script injects. cssComplete is
  // false when a stylesheet could not be read (cross-origin), so checks that
  // look for something missing can stand down instead of guessing.
  let cssCache, cssComplete = true;
  function allCss() {
    if (cssCache !== undefined) return cssCache;
    let out = '';
    for (const sh of document.styleSheets) {
      if (sh.ownerNode && (sh.ownerNode.id === 'dsc-slide-style' || sh.ownerNode.id === 'dsc-settle-style')) continue;
      try { for (const r of sh.cssRules) out += r.cssText + '\n'; } catch { cssComplete = false; }
    }
    cssCache = out;
    return cssCache;
  }
  function keyframeDirections() {
    const dirs = new Map();
    const walk = (rules) => {
      for (const r of rules) {
        if (r.type === CSSRule.KEYFRAMES_RULE) {
          const first = [...r.cssRules].find((k) => /^(from|0%)$/.test(k.keyText.trim())) || r.cssRules[0];
          const t = first ? first.style.transform || first.style.translate || '' : '';
          let d = null;
          const mx = t.match(/translateX\((-?[\d.]+)/) || t.match(/translate3?d?\((-?[\d.]+)[a-z%]*,\s*0/); const my = t.match(/translateY\((-?[\d.]+)/) || t.match(/translate3?d?\(\s*0[a-z%]*,\s*(-?[\d.]+)/);
          if (mx && Math.abs(parseFloat(mx[1])) > 0) d = parseFloat(mx[1]) < 0 ? 'left' : 'right';
          else if (my && Math.abs(parseFloat(my[1])) > 0) d = parseFloat(my[1]) > 0 ? 'below' : 'above';
          dirs.set(r.name, d);
        } else if (r.cssRules) walk(r.cssRules);
      }
    };
    for (const sh of document.styleSheets) { try { walk(sh.cssRules); } catch { /* cross-origin */ } }
    return dirs;
  }
  function motionChecks(root, els, sections, add) {
    // P56 same reveal on many sections
    const markers = new Map();
    const REVEAL_CLASS = /^(reveal|fade-?(in|up|left|right)|animate-on-scroll|scroll-reveal|aos-init|wow|appear|slide-up|js-reveal)$/i;
    for (const e of within(root, '*')) {
      const keys = [];
      if (e.hasAttribute('data-aos')) keys.push('data-aos=' + e.getAttribute('data-aos'));
      for (const a of ['data-animate', 'data-reveal', 'data-sal', 'data-scroll']) if (e.hasAttribute(a)) keys.push(a + '=' + e.getAttribute(a));
      for (const c of e.classList) if (REVEAL_CLASS.test(c)) keys.push('.' + c);
      const an = getComputedStyle(e).animationName;
      if (an && an !== 'none' && !/infinite/.test(getComputedStyle(e).animationIterationCount)) keys.push('animation ' + an);
      for (const k of keys) { if (!markers.has(k)) markers.set(k, []); markers.get(k).push(e); }
    }
    for (const [k, list] of markers) {
      const secs = new Set(list.map((e) => sections.find((s) => s.contains(e))).filter(Boolean));
      if (list.length >= 4 && secs.size >= 3) { add(56, list[0], `${list.length} elements across ${secs.size} sections share the same entrance (${k})`, { key: 'page' }); break; }
    }
    const css = allCss() || '';
    const lift = (css.match(/[^{}]*:hover[^{]*\{[^}]*transform:\s*translateY\(-[^}]*\}/g) || []).filter((r) => /(card|tile|feature|item|plan|panel|box)/i.test(r.split('{')[0]));
    if (lift.length && !markers.size) add(56, root, `every card lifts on hover (${short(lift[0].split('{')[0].trim(), 60)})`, { key: 'hover' });
    // P60 fly-in from every direction
    const dirs = keyframeDirections();
    const AOS_DIR = { 'fade-left': 'right', 'fade-right': 'left', 'fade-up': 'below', 'fade-down': 'above', 'slide-left': 'right', 'slide-right': 'left', 'slide-up': 'below', 'slide-down': 'above' };
    for (const sec of sections.slice(0, 3)) {
      const found = new Set(); const who = [];
      for (const e of sec.querySelectorAll('*')) {
        const an = getComputedStyle(e).animationName;
        const d = (an && dirs.get(an)) || AOS_DIR[e.getAttribute('data-aos')];
        if (d) { found.add(d); who.push(e); }
      }
      if (found.size >= 3 || (found.has('left') && found.has('right'))) { add(60, sec, `elements enter from ${[...found].join(', ')}`); break; }
    }
    // P55 fake typing cursor (fallback for impeccable's rule)
    {
      const cur = [...root.querySelectorAll('h1 *, h1 + *, h2 *')].filter((e) => { const s = cs(e); return /infinite/.test(s.animationIterationCount) && s.animationName !== 'none' && (/(blink|caret|cursor|type)/i.test(s.animationName + ' ' + e.className) || (e.getBoundingClientRect().width <= 12 && !ownText(e))); });
      if (cur.length) add(55, cur[0], `blinking cursor in the headline (animation ${cs(cur[0]).animationName})`, { key: 'page' });
    }
    // P61 floating loops on decorative elements
    const loops = els.filter((e) => {
      const s = getComputedStyle(e);
      if (!/infinite/.test(s.animationIterationCount) || s.animationName === 'none') return false;
      const r = e.getBoundingClientRect();
      if (r.width <= 18 && r.height <= 18) return false; // status dots are pattern 54
      if (r.width > innerWidth * 0.9) return false; // full-width moving rows are the marquee, pattern 58
      if (/(spin|load)/i.test(s.animationName) && r.width <= 48) return false;
      if (/(blink|caret|cursor)/i.test(s.animationName)) return false; // typing cursor is pattern 55
      return !ownText(e) || e.getAttribute('aria-hidden') === 'true';
    });
    if (loops.length) add(61, loops[0], `${loops.length} decorative element(s) loop forever (${[...new Set(loops.map((e) => getComputedStyle(e).animationName))].slice(0, 3).join(', ')})`, { key: 'page' });
  }

  // ---------- signatures and judgement facts ----------
  function blockKind(el) {
    if (el.matches(HEADING)) return 'H';
    if (el.matches('ul,ol')) return 'L';
    if (el.matches('img,svg,video,canvas,picture,figure')) return 'M';
    if (el.matches('p,blockquote')) return 'P';
    if (el.children.length >= 3) return 'G' + Math.min(el.children.length, 6);
    if (el.children.length) return blockKind(el.children[0]);
    return 'T';
  }
  function layoutOf(root) {
    const r = root === document.body ? { left: 0, width: innerWidth, top: 0, height: innerHeight } : root.getBoundingClientRect();
    // Unwrap single-child wrappers so a slide's inner container is compared, not the wrapper.
    let base = root;
    for (let i = 0; i < 3; i++) { const k = [...base.children].filter((c) => visible(c) && !/^(SCRIPT|STYLE)$/.test(c.tagName)); if (k.length === 1 && k[0].children.length) base = k[0]; else break; }
    const top = [...base.children].filter((k) => visible(k) && !/^(SCRIPT|STYLE)$/.test(k.tagName)).slice(0, 8);
    const media = [...root.querySelectorAll('img,svg,video,canvas,picture')].filter(visible).filter((m) => { const b = m.getBoundingClientRect(); return b.width >= r.width * 0.2 && b.height >= 80; });
    const lr = (el) => { const b = el.getBoundingClientRect(); return (b.left + b.width / 2) < r.left + r.width / 2 ? 'L' : 'R'; };
    return { r, media, lr, layout: top.map(blockKind).join('-') + (media.length ? '|M' + lr(media[0]) : '') };
  }
  // Where the content sits between the header block (title plus subhead) and the footer.
  // Measured on what is drawn: text lines, images and visible boxes, never the flex container,
  // so a container that stretches to the footer does not hide content pinned to its top.
  // Returns { skip: reason } when the question does not apply to this slide.
  function placement(root) {
    const sr = root.getBoundingClientRect(); const H = sr.height, W = sr.width;
    const skip = (why) => ({ skip: why });
    const hint = (root.getAttribute('class') || '') + ' ' + (root.id || '');
    // Class names are only an extra hint; the structure checks below do the real work.
    if (/cover|divider|thank|closing|title-?slide|section-?break/i.test(hint)) return skip('cover, divider or closing slide');
    const heading = [...root.querySelectorAll(HEADING)].find(visible);
    if (!heading) return skip('no header block');
    const textRect = (n) => { const rg = document.createRange(); rg.selectNodeContents(n); return rg.getBoundingClientRect(); };
    const hr = textRect(heading);
    if (hr.top - sr.top > 0.3 * H) return skip('heading is not at the top of the slide');
    // A title centred in the slide (cover, divider, thank-you) has no header-then-content shape.
    if (Math.abs((hr.top + hr.bottom) / 2 - (sr.top + sr.bottom) / 2) < 0.12 * H) return skip('title is centred in the slide');
    // The header block: the heading plus at most one subhead that sits close under it. A real
    // header element or a wrapper named "head..." is taken whole; any other wrapper is not, so
    // body paragraphs that share a div with the heading stay content.
    let base = root;
    for (let i = 0; i < 3; i++) { const k = [...base.children].filter((c) => visible(c) && !/^(SCRIPT|STYLE)$/.test(c.tagName)); if (k.length === 1 && k[0].children.length) base = k[0]; else break; }
    let hdr = heading; while (hdr.parentElement && hdr.parentElement !== base && hdr.parentElement !== root) hdr = hdr.parentElement;
    // Rendered scale: rects include ancestor transforms; computed lengths (padding, borders, gaps) do not.
    const sy = root.offsetHeight ? sr.height / root.offsetHeight : 1, sx = root.offsetWidth ? sr.width / root.offsetWidth : 1;
    const SUBHEAD_CLASS = /(^|[-_\s])(lede|lead|sub|subtitle|subhead|subheading|intro|standfirst|deck|summary)($|[-_\s])/i;
    const headingFs = px(cs(heading).fontSize) || 16;
    let headEls;
    if (hdr !== heading && (hdr.matches('header,[role=banner]') || /head/i.test(hdr.getAttribute('class') || '')) && hdr.getBoundingClientRect().height <= 0.4 * H) headEls = [hdr];
    else {
      headEls = [heading];
      const scope = hdr !== heading ? hdr : (heading.parentElement || root);
      const after = [...scope.querySelectorAll('p,div,span,h3,h4,h5,h6')].find((e) => (heading.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) && !heading.contains(e) && visible(e) && text(e).length > 0 && !e.querySelector('p,div,ul,ol,h1,h2,h3,h4,h5,h6,img,svg'));
      if (after) {
        const ar = textRect(after);
        const gap = ar.top - hr.bottom;
        // Close under the heading, and styled as a subhead: a lede-like class, or a short one-to-two line text no bigger than the heading.
        const subLike = SUBHEAD_CLASS.test(after.getAttribute('class') || '') || (text(after).length <= 200 && ar.height <= 3.2 * (px(cs(after).fontSize) || 16) * sy);
        // Body text looks like the text further down the slide (same size, color, weight, style); a subhead is styled differently from it.
        // When nothing else on the slide can be compared, the paragraph is ambiguous and stays in the header.
        const styleKey = (e) => { const c = cs(e); return [Math.round(px(c.fontSize)), c.color, c.fontWeight, c.fontStyle].join('|'); };
        const myKey = styleKey(after);
        const sameAsBody = !SUBHEAD_CLASS.test(after.getAttribute('class') || '') && [...root.querySelectorAll('p,li,div,span')].some((e) => e !== after && (after.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) && !after.contains(e) && !e.querySelector('p,div,ul,ol,li,h1,h2,h3,h4,h5,h6') && visible(e) && text(e).length >= 12 && styleKey(e) === myKey);
        if (gap >= -2 && gap <= Math.max(40 * sy, 0.8 * hr.height) && subLike && !sameAsBody && (px(cs(after).fontSize) || 16) <= headingFs) headEls = [heading, after];
      }
    }
    const inHead = (n) => headEls.some((h) => h.contains(n));
    // What is actually drawn: the rect cut to the slide and to every overflow-clipping ancestor. Empty means off-slide or clipped away.
    const clip = (el, r) => {
      let L = Math.max(r.left, sr.left), T = Math.max(r.top, sr.top), R = Math.min(r.right, sr.right), B = Math.min(r.bottom, sr.bottom);
      // Each axis is cut on its own (overflow-x: clip with overflow-y: visible does not cut vertically), at the padding box, inside the borders.
      const clipping = /^(hidden|clip|auto|scroll)$/;
      for (let n = el; n && n !== root && n.nodeType === 1; n = n.parentElement) {
        const s2 = cs(n); const cx = clipping.test(s2.overflowX), cy = clipping.test(s2.overflowY);
        if (!cx && !cy) continue;
        const c = n.getBoundingClientRect();
        if (cx) { L = Math.max(L, c.left + px(s2.borderLeftWidth) * sx); R = Math.min(R, c.right - px(s2.borderRightWidth) * sx); }
        if (cy) { T = Math.max(T, c.top + px(s2.borderTopWidth) * sy); B = Math.min(B, c.bottom - px(s2.borderBottomWidth) * sy); }
      }
      return R - L > 1 && B - T > 1 ? { left: L, top: T, right: R, bottom: B, width: R - L, height: B - T } : null;
    };
    const skipTag = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) {
      const t = walker.currentNode; const par = t.parentElement;
      if (!par || skipTag.test(par.tagName) || !t.textContent.trim() || !visible(par) || par.closest('svg')) continue;
      const rg = document.createRange(); rg.selectNodeContents(t); const r = rg.getBoundingClientRect();
      const cr = r.width > 1 && r.height > 1 ? clip(par, r) : null;
      if (cr) texts.push({ el: par, r: cr });
    }
    let headerBottom = hr.bottom;
    for (const t of texts) if (inHead(t.el)) headerBottom = Math.max(headerBottom, t.r.bottom);
    // The footer: a footer-like element in the bottom fifth. Without one, the slide's bottom padding edge.
    const foots = [...root.querySelectorAll('footer,[role=contentinfo],[class*=footer],[class*=foot]')].filter((e) => { if (!visible(e) || e.contains(heading)) return false; const r = e.getBoundingClientRect(); return r.top >= sr.top + 0.7 * H && r.height <= 0.2 * H; });
    const inFoot = (n) => foots.some((f) => f.contains(n));
    const padB = px(cs(root).paddingBottom) * sy;
    let footerTop = foots.length ? Math.min(...foots.map((f) => f.getBoundingClientRect().top)) : sr.bottom - padB;
    const items = [];
    for (const t of texts) if (!inHead(t.el) && !inFoot(t.el)) items.push({ el: t.el, r: t.r, kind: 'text' });
    for (const m of within(root, 'img,svg,video,canvas,picture')) {
      if (!visible(m) || (m.tagName === 'svg' && m.parentElement.closest('svg')) || inHead(m) || inFoot(m)) continue;
      const r = clip(m, m.getBoundingClientRect()); if (r && r.width >= 8 && r.height >= 8) items.push({ el: m, r, kind: 'media' });
    }
    for (const b of within(root, 'div,section,article,aside,figure,ul,ol,table,blockquote')) {
      if (b === root || !visible(b) || inHead(b) || inFoot(b) || b.contains(heading) || !isBox(b)) continue;
      const br = clip(b, b.getBoundingClientRect()); if (br) items.push({ el: b, r: br, kind: 'box' });
    }
    // A slide-sized picture is a full-bleed layout (text sits on top of it): decide that before background shapes are dropped.
    if (items.some((i) => i.kind === 'media' && i.r.width >= 0.95 * W && i.r.height >= 0.9 * H)) return skip('full-bleed picture or panel');
    // Page-number chrome in the bottom strip is not content; a slide-sized background shape is not either.
    const live = items.filter((i) => !(i.r.top >= sr.bottom - 0.08 * H && i.r.height < 0.05 * H) && !(i.r.width >= 0.95 * W && i.r.height >= 0.9 * H));
    if (live.some((i) => i.kind !== 'text' && i.r.height >= 0.85 * H)) return skip('full-height panel (split or full-bleed layout)');
    if (live.some((i) => i.kind !== 'text' && i.r.width * i.r.height >= 0.6 * W * H)) return skip('full-bleed picture or panel');
    if (live.some((i) => i.r.top < headerBottom - 6 && i.r.bottom > headerBottom + 6)) return skip('content sits beside the header');
    // A full-width strip sitting on the bottom edge (takeaway bar, call to action) is bottom chrome like a footer.
    const strip = live.filter((i) => i.kind !== 'text' && i.r.bottom >= footerTop - 4 && i.r.bottom <= footerTop + 4 && i.r.width >= 0.8 * (W - (px(cs(root).paddingLeft) + px(cs(root).paddingRight)) * sx) && i.r.height < 0.15 * H && i.r.top > headerBottom).sort((a, b) => b.r.height - a.r.height)[0];
    if (strip) footerTop = strip.r.top;
    const body = live.filter((i) => i.r.bottom > headerBottom + 1 && i.r.top < footerTop && !(strip && strip.el.contains(i.el)));
    if (!body.length) return skip('no content below the header');
    const cTop = Math.min(...body.map((i) => i.r.top)), cBot = Math.min(footerTop, Math.max(...body.map((i) => i.r.bottom)));
    const area = footerTop - headerBottom, contentH = cBot - cTop;
    const m = { H: Math.round(H), headerBottom: Math.round(headerBottom - sr.top), footerTop: Math.round(footerTop - sr.top), contentTop: Math.round(cTop - sr.top), contentBottom: Math.round(cBot - sr.top), topGap: Math.round(cTop - headerBottom), bottomGap: Math.round(footerTop - cBot), area: Math.round(area), fill: +(contentH / area).toFixed(3), footer: foots.length > 0 || !!strip };
    if (area < 0.25 * H) return skip('very little room between header and footer');
    if (contentH < 0.05 * H) return skip('almost no content');
    if (contentH / area > 0.8) return skip('content fills nearly all the space');
    return m;
  }
  function signature(root, isSlide) {
    const { r, media, lr, layout } = layoutOf(root);
    const list = [...root.querySelectorAll('ul,ol')].filter(visible)[0];
    const title = root.querySelector(HEADING);
    const logo = [...root.querySelectorAll('img,svg,[class*=logo]')].filter(visible).find((x) => /logo/i.test((x.getAttribute('class') || '') + ' ' + (x.getAttribute('alt') || '') + ' ' + (x.getAttribute('src') || '') + ' ' + (x.id || '')));
    const lb = logo && logo.getBoundingClientRect();
    const btn = [...root.querySelectorAll('button,a')].find(isButton);
    return {
      layout,
      // Coarse shape for "same template" checks: list or not, image side, size of the biggest group.
      coarse: [list ? 'list' : '', media.length ? 'img-' + lr(media[0]) : '', (() => { let g = 0; for (const e of root.querySelectorAll('div,ul,ol')) { const k = [...e.children].filter(visible).length; if (k >= 3 && isBox(e.children[0] || e)) g = Math.max(g, k); } return g ? 'grid' + g : ''; })()].filter(Boolean).join('+') || 'text',
      sections: isSlide ? [] : topSections(root).map((sec) => ({ sel: cssPath(sec), layout: layoutOf(sec).layout })),
      placement: isSlide ? placement(root) : null,
      hasMedia: media.length > 0,
      bulletsLeftImageRight: !!(list && media.length && lr(list) === 'L' && lr(media[0]) === 'R'),
      titleFont: title ? firstFamily(cs(title)) + ' ' + Math.round(px(cs(title).fontSize)) + 'px ' + cs(title).fontWeight : null,
      titleColor: title ? hex(rgba(cs(title).color)) : null,
      // The body font is the one carrying the most body-size text; display quotes are left out.
      bodyFont: (() => {
        const tally = new Map();
        for (const p of root.querySelectorAll('p,li')) { if (!visible(p) || px(cs(p).fontSize) > 30) continue; const f = firstFamily(cs(p)); tally.set(f, (tally.get(f) || 0) + text(p).length); }
        const top = [...tally].sort((a, b) => b[1] - a[1])[0];
        return top ? top[0] : null;
      })(),
      buttonStyle: btn ? btnStyle(btn).key : null,
      logo: lb ? { x: Math.round(lb.left - r.left), y: Math.round(lb.top - r.top), w: Math.round(lb.width) } : null,
      bg: hex(effectiveBg(root === document.body ? document.body : root)),
    };
  }
  function facts(root) {
    const sections = topSections(root).map((s) => ({
      sel: cssPath(s),
      heading: short(text(s.querySelector(HEADING) || s).slice(0, 90), 90),
      kids: s.querySelectorAll('*').length,
      images: s.querySelectorAll('img,svg,picture,video').length,
      buttons: [...s.querySelectorAll('a,button')].filter(isButton).map((b) => short(text(b), 30)).slice(0, 5),
    }));
    const h1 = root.querySelector('h1');
    const nums = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode() && nums.length < 200) {
      const t = walker.currentNode.textContent;
      for (const m of t.matchAll(/[$€£]?\s?\d[\d.,]*\s?(%|x|×|k|K|M|B|bn|\+)?/g)) if (/\d/.test(m[0]) && m[0].trim().length > 1) nums.push(short(m[0].trim(), 20) + '  ← "' + short(t.replace(/\s+/g, ' ').trim(), 60) + '"');
    }
    const threes = [];
    for (const p of within(root, 'ul,ol,div,section')) {
      const k = [...p.children].filter(visible);
      if (k.length === 3 && k.every((x) => text(x).length > 10 && text(x).length < 300)) threes.push(k.map((x) => short(text(x), 90)));
      if (threes.length >= 8) break;
    }
    const images = within(root, 'img,picture img,video,canvas,svg').filter((i) => { const r = i.getBoundingClientRect(); return visible(i) && r.width >= 120 && r.height >= 80 && !(i.tagName === 'svg' && i.parentElement.closest('svg')); }).slice(0, 20).map((i) => {
      const r = i.getBoundingClientRect();
      return { sel: cssPath(i), kind: i.tagName.toLowerCase(), src: (i.currentSrc || i.getAttribute('src') || '').slice(0, 120), alt: i.getAttribute('alt') || '', size: Math.round(r.width) + '×' + Math.round(r.height), at: Math.round(r.left) + ',' + Math.round(r.top + scrollY) };
    });
    const modals = within(root, 'dialog,[role=dialog],[role=alertdialog],[class*=modal],[aria-modal=true]').slice(0, 5).map((m) => ({ sel: cssPath(m), text: short(text(m), 140), open: visible(m) }));
    const logos = within(root, 'img,svg').filter((i) => /logo/i.test((i.getAttribute('class') || '') + (i.getAttribute('alt') || '') + (i.getAttribute('src') || '') + (i.id || ''))).slice(0, 10).map((i) => ({ sel: cssPath(i), src: (i.getAttribute('src') || '').slice(0, 100), alt: i.getAttribute('alt') || '' }));
    return {
      title: document.title,
      h1: h1 ? text(h1) : null,
      sections,
      numbers: nums,
      groupsOfThree: threes,
      images,
      modals,
      logos,
      copy: short(text(root), 4000),
    };
  }

  // P79 off-brand colors: generated images whose main colors sit close to,
  // but not on, a brand color. Runs only when brand colors are given.
  function brandCheck(root, brand) {
    const hits = [];
    const brandC = brand.map(rgba).filter(Boolean);
    for (const img of within(root, 'img').filter(visible)) {
      const r = img.getBoundingClientRect();
      if (r.width < 160 || r.height < 100 || !img.complete || !img.naturalWidth) continue;
      try {
        const c = document.createElement('canvas'); c.width = c.height = 40;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0, 40, 40);
        const d = g.getImageData(0, 0, 40, 40).data; const bins = new Map();
        for (let i = 0; i < d.length; i += 4) {
          const q = { r: d[i] & 0xf0, g: d[i + 1] & 0xf0, b: d[i + 2] & 0xf0, a: 1 };
          if (oklch(q).C < 0.06) continue;
          const k = hex(q); bins.set(k, (bins.get(k) || 0) + 1);
        }
        const top = [...bins.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).filter(([, n]) => n >= 80);
        for (const [k] of top) {
          const col = rgba(k);
          const near = brandC.map((b) => ({ b, d: dE(col, b) })).sort((a, b) => a.d - b.d)[0];
          if (near && near.d > 0.05 && near.d < 0.16) { hits.push({ p: 79, sel: cssPath(img), text: img.getAttribute('alt') || '', ev: `image's main color ${k} is near brand ${hex(near.b)} but not on it`, conf: 'review', key: cssPath(img), id: img.id || null }); break; }
        }
      } catch { /* cross-origin image */ }
    }
    return hits;
  }

  window.__dsc = {
    findSlides: (custom) => findSlides(custom).length,
    activateSlide,
    settleForScreenshot,
    // Areas worth a close look: each top-level section and each large image, in page coordinates.
    crops() {
      const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.max(0, Math.round(r.left)), y: Math.max(0, Math.round(r.top + scrollY)), width: Math.round(Math.min(r.width, innerWidth)), height: Math.round(r.height) }; };
      const sections = topSections(document.body).slice(0, 14).map((s) => ({ kind: 'section', sel: cssPath(s), ...box(s) }));
      const images = [...document.querySelectorAll('img,svg,canvas,video,picture')].filter((i) => { if (!visible(i) || (i.tagName === 'svg' && i.parentElement.closest('svg'))) return false; const r = i.getBoundingClientRect(); return r.width >= 200 && r.height >= 120; }).slice(0, 14).map((i) => ({ kind: 'image', sel: cssPath(i), ...box(i) }));
      return [...sections, ...images].filter((c) => c.width > 0 && c.height > 0);
    },
    motion() {
      const hits = [];
      const add = (p, el, ev, extra = {}) => hits.push({ p, sel: el ? cssPath(el) : null, text: el ? short(text(el), 80) : null, ev, conf: extra.conf || 'high', key: extra.key || (el ? cssPath(el) : String(p)), id: el && el.id ? el.id : null });
      motionChecks(document.body, allVisible(document.body), topSections(document.body), add);
      return hits;
    },
    run(opts) {
      const scope = { web: opts.mode !== 'slide', slides: opts.mode === 'slide' };
      let root = document.body;
      if (opts.mode === 'slide') root = findSlides(opts.slideSelector)[opts.slideIndex];
      return {
        hits: collect(root, { mode: opts.mode, scope, motion: 'skip' }).concat(opts.brand && opts.brand.length ? brandCheck(root, opts.brand) : []),
        signature: signature(root, opts.mode === 'slide'),
        facts: facts(root),
        size: { w: innerWidth, h: innerHeight, docH: document.documentElement.scrollHeight },
      };
    },
  };
})();

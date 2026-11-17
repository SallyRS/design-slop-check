#!/usr/bin/env node
// Design Slop Check: scans HTML pages and HTML slide decks for the patterns on
// Sally's AI slop design list and writes one fix list (report.md + report.json).
//
//   node check.mjs <file|folder|url>... [options]
//   node check.mjs --merge judgement.json --report <out>/report.json
//
// Options
//   --out DIR            where to write the report (default ./design-slop-check-report)
//   --mode auto|web|slides   treat targets as web pages or decks (default auto)
//   --slides SELECTOR    CSS selector for slides when auto-detection misses them
//   --viewport WxH       web viewport (default 1440x900)
//   --slide-viewport WxH deck viewport (default 1600x900)
//   --brand "#hex,#hex"  brand colors, turns on the off-brand color check
//   --compare OLD.json   mark each finding new / still there, and list what was fixed
//   --no-impeccable      skip impeccable's detector
//   --no-screenshots     skip screenshots (the judgement step then has only text)
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, join, basename, dirname, extname, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { launchChrome, openPage, findChrome } from './lib/chrome.mjs';
import { renderMarkdown, finalize } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PATTERNS = JSON.parse(readFileSync(join(HERE, 'patterns.json'), 'utf8'));
const BY_N = new Map(PATTERNS.map((p) => [p.n, p]));
const COLLECTOR = readFileSync(join(HERE, 'lib', 'collector.js'), 'utf8');

// impeccable rule id -> Sally's pattern number. Rules not listed here are
// general quality checks that are not on the list; they are counted, not reported.
const IMPECCABLE_MAP = {
  'kicker-above-heading': 1, 'hero-eyebrow-chip': 1, 'icon-tile-stack': 5, 'nested-cards': 6,
  'numbered-section-labels': 8, 'monotonous-spacing': 10, 'oversized-h1': 11, 'text-occlusion': 21,
  'overused-font': 23, 'italic-serif-display': 24, 'flat-type-hierarchy': 27, 'extreme-negative-tracking': 28,
  'tiny-text': 29, 'low-contrast': 29, 'gray-on-color': 29, 'ai-color-palette': 33, 'gradient-text': 34,
  'cream-palette': 35, 'side-tab': 38, 'border-accent-on-rounded': 38, 'codex-grid-background': 40,
  'repeating-stripes-gradient': 40, 'gpt-thin-border-wide-shadow': 47, 'dark-glow': 48, 'radial-halo': 48,
  'radial-spotlight-glow': 48, 'hard-offset-shadow': 49, 'shape-assembled-illustration': 53, 'broken-image': 53,
  'pulsing-dot': 54, 'blinking-cursor': 55, 'bounce-easing': 57, 'marquee': 58,
  'text-overflow': 82, 'clipped-overflow-container': 82, 'script-error': 82,
};

function parseArgs(argv) {
  const o = { targets: [], out: 'design-slop-check-report', mode: 'auto', viewport: '1440x900', slideViewport: '1600x900', impeccable: true, screenshots: true, brand: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '--out') o.out = val();
    else if (a === '--mode') o.mode = val();
    else if (a === '--slides') o.slideSelector = val();
    else if (a === '--viewport') o.viewport = val();
    else if (a === '--slide-viewport') o.slideViewport = val();
    else if (a === '--brand') o.brand = val().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--compare') o.compare = val();
    else if (a === '--merge') o.merge = val();
    else if (a === '--report') o.report = val();
    else if (a === '--no-impeccable') o.impeccable = false;
    else if (a === '--no-screenshots') o.screenshots = false;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    else o.targets.push(a);
  }
  if (!['auto', 'web', 'slides'].includes(o.mode)) throw new Error('--mode must be auto, web or slides');
  return o;
}
const dims = (s) => { const m = /^(\d+)x(\d+)$/.exec(s); if (!m) throw new Error(`Bad size ${s}, use WxH`); return { width: +m[1], height: +m[2] }; };

function expandTargets(targets) {
  const out = [];
  for (const t of targets) {
    if (/^(https?|file):\/\//i.test(t)) { out.push({ url: t, file: t.startsWith('file:') ? fileURLToPath(t) : null, label: t }); continue; }
    const p = resolve(t);
    if (!existsSync(p)) throw new Error(`Not found: ${t}`);
    if (statSync(p).isDirectory()) {
      const walk = (d) => {
        for (const f of readdirSync(d).sort()) {
          if (f.startsWith('.') || f === 'node_modules') continue;
          const fp = join(d, f);
          if (statSync(fp).isDirectory()) walk(fp);
          else if (/\.html?$/i.test(f)) out.push({ url: pathToFileURL(fp).href, file: fp, label: labelFor(fp) });
        }
      };
      walk(p);
    } else out.push({ url: pathToFileURL(p).href, file: p, label: labelFor(p) });
  }
  if (!out.length) throw new Error('No HTML files found in the targets.');
  return out;
}

function findImpeccable() {
  const cands = [process.env.IMPECCABLE_BIN];
  const cache = join(homedir(), '.claude/plugins/cache/impeccable/impeccable');
  if (existsSync(cache)) {
    const vers = readdirSync(cache).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of vers) cands.push(join(cache, v, 'skills/impeccable/scripts/impeccable'));
  }
  cands.push(join(homedir(), '.impeccable/bin/impeccable'));
  for (const c of cands.filter(Boolean)) if (existsSync(c)) return c;
  try { return execFileSync('/usr/bin/which', ['impeccable'], { encoding: 'utf8' }).trim() || null; } catch { return null; }
}

function runImpeccable(bin, pages) {
  const args = ['detect', '--json', '--no-config', '--no-inline-ignores', ...pages.map((p) => p.file || p.url)];
  let raw;
  try { raw = execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 }); }
  catch (e) { if (e.status === 2 && e.stdout) raw = e.stdout; else throw new Error('impeccable detect failed: ' + String(e.stderr || e.message).slice(0, 300)); }
  return JSON.parse(raw || '[]');
}

// Best-effort line number: look for the element's id, then its text, then its class.
function lineFor(src, hit) {
  if (!src) return null;
  const lines = src.split('\n');
  const bodyStart = Math.max(0, lines.findIndex((l) => /<body[\s>]/i.test(l)));
  const find = (needle) => {
    if (!needle) return null;
    let i = lines.findIndex((l, k) => k >= bodyStart && l.includes(needle));
    if (i < 0) i = lines.findIndex((l) => l.includes(needle));
    return i >= 0 ? i + 1 : null;
  };
  if (hit.id) { const l = find(`id="${hit.id}"`) || find(`id='${hit.id}'`); if (l) return l; }
  const t = (hit.text || '').replace(/…$/, '').trim();
  if (t.length >= 4) {
    for (const len of [40, 24, 12]) { const l = find(t.slice(0, len)); if (l) return l; }
  }
  const cls = /\.([A-Za-z_][\w-]*)/.exec((hit.sel || '').split(' > ').pop() || '');
  if (cls) {
    const re = new RegExp(`class=["'][^"']*\\b${cls[1]}\\b`);
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) return i + 1;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Full paths, so a fixing agent started anywhere can open the file.
function labelFor(fp) { return resolve(fp); }
import { createHash } from 'node:crypto';
const shortHash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 8);
const slug = (s) => shortHash(s) + '-' + (/^[a-z]+:\/\//i.test(s) ? s : s.split('/').slice(-2).join('-')).replace(/^file:\/\//, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(-50);
const slugOld = (s) => (/^[a-z]+:\/\//i.test(s) ? s : s.split('/').slice(-2).join('-')).replace(/^file:\/\//, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(-60) || 'page';

async function scanPage(browser, page, opts, outDir) {
  const web = dims(opts.viewport), deck = dims(opts.slideViewport);
  const tab = await openPage(browser, web);
  const res = { label: page.label, file: page.file, url: page.url, kind: 'web', hits: [], units: [], errors: [] };
  try {
    await tab.goto(page.url);
    await tab.evaluate(COLLECTOR);
    const nSlides = opts.mode === 'web' ? 0 : await tab.evaluate(`window.__dsc.findSlides(${JSON.stringify(opts.slideSelector || null)})`);
    if (opts.mode === 'slides' && nSlides < 1) throw new Error('No slides found. Pass --slides "<selector>" for this deck.');
    const base = slug(page.label);
    if (nSlides >= 2 || (opts.mode === 'slides' && nSlides >= 1)) {
      res.kind = 'deck';
      await tab.close();
      const t2 = await openPage(browser, deck);
      await t2.goto(page.url);
      await t2.evaluate(COLLECTOR);
      await t2.evaluate('window.__dsc.settleForScreenshot()');
      for (let i = 0; i < nSlides; i++) {
        await t2.evaluate(`window.__dsc.activateSlide(${i}, ${JSON.stringify(opts.slideSelector || null)})`);
        await sleep(120);
        const r = await t2.evaluate(`window.__dsc.run(${JSON.stringify({ mode: 'slide', slideIndex: i, slideSelector: opts.slideSelector || null, brand: opts.brand })})`);
        let shot = null;
        if (opts.screenshots) { shot = join(outDir, 'screenshots', `${base}-slide-${String(i + 1).padStart(2, '0')}.png`); writeFileSync(shot, await t2.screenshot()); }
        res.units.push({ slide: i + 1, signature: r.signature, facts: r.facts, screenshot: shot });
        for (const h of r.hits) res.hits.push({ ...h, slide: i + 1 });
      }
      res.errors.push(...t2.errors);
      await t2.close();
      return res;
    }
    // Web page: read motion first, then trigger scroll reveals, then measure.
    const motion = await tab.evaluate('window.__dsc.motion()');
    await tab.evaluate(`(async () => { const h = document.documentElement.scrollHeight; for (let y = 0; y < h; y += Math.round(innerHeight * 0.8)) { scrollTo(0, y); await new Promise(r => setTimeout(r, 60)); } scrollTo(0, 0); })()`);
    await tab.evaluate('window.__dsc.settleForScreenshot()');
    await sleep(150);
    const r = await tab.evaluate(`window.__dsc.run(${JSON.stringify({ mode: 'web', brand: opts.brand })})`);
    let shots = [];
    if (opts.screenshots) {
      const a = join(outDir, 'screenshots', `${base}-first-screen.png`); writeFileSync(a, await tab.screenshot());
      const b = join(outDir, 'screenshots', `${base}-full.png`); writeFileSync(b, await tab.screenshot({ fullPage: true }));
      shots = [a, b];
    }
    // Close-ups at full size: a whole-page screenshot is shrunk when viewed, so text
    // in images and below the first screen needs its own crop to be readable.
    const crops = [];
    if (opts.screenshots) {
      const list = await tab.evaluate('window.__dsc.crops()');
      let k = 0;
      for (const c of list) {
        const clip = { x: c.x, y: c.y, width: c.width, height: Math.min(c.height, 1800) };
        const f = join(outDir, 'screenshots', `${base}-${c.kind}-${String(++k).padStart(2, '0')}.png`);
        try { writeFileSync(f, await tab.screenshot({ clip })); crops.push({ kind: c.kind, sel: c.sel, path: f, cut: c.height > 1800 }); } catch { /* off-page element */ }
      }
    }
    res.units.push({ slide: null, signature: r.signature, facts: r.facts, screenshot: shots[0] || null, screenshotFull: shots[1] || null, crops, truncated: r.size.docH > 6000, size: r.size });
    res.hits.push(...motion, ...r.hits);
    res.errors.push(...tab.errors);
  } finally {
    await tab.close();
  }
  return res;
}

// Checks that compare several pages or slides.
function crossChecks(page) {
  const out = [];
  const add = (p, ev, extra = {}) => out.push({ p, sel: null, text: null, ev, conf: extra.conf || 'high', key: extra.key || 'cross', slide: extra.slide ?? null, slides: extra.slides || null });
  const u = page.units;
  if (page.kind === 'deck' && u.length >= 2) {
    const content = u.slice(1); // the cover slide is allowed to differ
    const fam = (s) => (s.signature.titleFont || '').split(' ').slice(0, -2).join(' ');
    const fams = new Map();
    for (const s of content) if (fam(s)) fams.set(fam(s), (fams.get(fam(s)) || []).concat(s.slide));
    const minority = (m) => [...m].sort((a, b) => a[1].length - b[1].length).slice(0, -1).flatMap(([, sl]) => sl);
    if (fams.size >= 2) add(14, `slide titles use ${fams.size} fonts: ${[...fams].map(([f, sl]) => `${f} (slides ${sl.join(', ')})`).join('; ')}`, { key: 'title-font', slides: minority(fams) });
    const bodies = new Map();
    for (const s of content) if (s.signature.bodyFont) bodies.set(s.signature.bodyFont, (bodies.get(s.signature.bodyFont) || []).concat(s.slide));
    if (bodies.size >= 2) add(14, `body text uses ${bodies.size} fonts: ${[...bodies].map(([f, sl]) => `${f} (slides ${sl.join(', ')})`).join('; ')}`, { key: 'body-font', slides: minority(bodies) });
    const logos = u.filter((s) => s.signature.logo);
    if (logos.length >= 3) {
      const ref = logos.map((s) => `${Math.round(s.signature.logo.x / 24)},${Math.round(s.signature.logo.y / 24)}`);
      const common = [...new Set(ref)].map((k) => [k, ref.filter((x) => x === k).length]).sort((a, b) => b[1] - a[1])[0][0];
      const off = logos.filter((s, i) => ref[i] !== common).map((s) => s.slide);
      if (off.length) add(82, `logo sits in a different spot on slides ${off.join(', ')}`, { key: 'logo', slides: off });
    }
    if (u.length >= 4) {
      const lay = new Map();
      for (const s of content) lay.set(s.signature.coarse, (lay.get(s.signature.coarse) || []).concat(s.slide));
      const [l, sl] = [...lay].sort((a, b) => b[1].length - a[1].length)[0];
      if ((sl.length >= 4 && sl.length / content.length >= 0.4) || (sl.length >= 3 && sl.length / content.length >= 0.6)) add(77, `${sl.length} of ${content.length} content slides share one layout (${l}): slides ${sl.join(', ')}`, { key: 'layout', conf: 'review', slides: sl });
      const media = u.filter((s) => s.signature.hasMedia).map((s) => s.slide);
      if (media.length / u.length >= 0.8) add(18, `${media.length} of ${u.length} slides carry a large image`, { key: 'media', conf: 'review', slides: media });
    }
    // #101 content pushed to the top or bottom (extra check, not on Sally's published list).
    // Each content slide reports the empty space under its header block (topGap) and above its
    // footer or bottom edge (bottomGap); share = topGap / (topGap + bottomGap), 0.5 when centred.
    // A slide counts as strongly lopsided at share 0.25 / 0.75, with size floors (the bigger gap at
    // least 12% of the slide height, the two gaps differing by at least 10%) so thin margins on a
    // small slide stay out. Deck context is needed because a deck may place content low on every
    // slide on purpose: a slide is flagged only when the deck leans one way as a whole or when it is
    // lopsided while the rest are centred. A looser lean
    // (0.35 / 0.65, gaps differing by 8%) is only used to see which way the deck as a whole goes.
    // A top-aligned slide is ordinary design on its own (the clean fixtures have them), so a
    // slide is only flagged against the rest of the deck: when most comparable slides lean the
    // same way, or when it is the odd one out in a deck that is otherwise centred. With fewer
    // than 4 comparable slides there is nothing to compare, so nothing is flagged.
    // The normal gap between title and content is never flagged by itself.
    {
      const meas = u.map((s) => ({ slide: s.slide, m: s.signature.placement, shot: s.screenshot })).filter((x) => x.m && !x.m.skip && x.m.H).map((x) => {
        const top = Math.max(0, x.m.topGap), bot = Math.max(0, x.m.bottomGap);
        const share = top / (top + bot || 1), diff = Math.abs(top - bot) / x.m.H, big = Math.max(top, bot) / x.m.H;
        return { ...x, top, bot, share, diff, dir: share < 0.5 ? 'top' : 'bottom', strict: (share <= 0.25 || share >= 0.75) && big >= 0.12 && diff >= 0.10, lean: (share <= 0.35 || share >= 0.65) && diff >= 0.08, balanced: share > 0.35 && share < 0.65 };
      });
      page.placementRan = meas.length >= 4;
      if (meas.length >= 4) {
        const leaning = (dir) => meas.filter((x) => x.lean && x.dir === dir);
        const deckDir = ['top', 'bottom'].find((d) => leaning(d).length >= 3 && leaning(d).length / meas.length >= 0.6) || null;
        const flagged = [];
        const say = (x, why) => `content sits ${x.dir === 'top' ? 'against the heading' : 'at the bottom'}: ${x.top}px of space between the header and the content, ${x.bot}px between the content and the ${x.m.footer ? 'footer' : 'bottom edge'} (${Math.round(x.share * 100)}% / ${Math.round((1 - x.share) * 100)}%)${why}.${x.shot ? ` Screenshot: ${basename(x.shot)}.` : ''}`;
        for (const x of meas) {
          if (!x.strict) continue;
          if (deckDir) {
            // Leaning with the deck, or lopsided the other way from it.
            flagged.push([x, x.dir === deckDir ? '' : `, the opposite way from the rest of the deck, which sits ${deckDir === 'top' ? 'under the heading' : 'low'}`]);
          } else if (meas.length >= 5 && meas.filter((y) => y !== x && y.balanced).length >= 0.8 * (meas.length - 1)) {
            flagged.push([x, ', while the other content slides are centred']);
          }
        }
        for (const [x, why] of flagged) add(101, say(x, why), { key: 'placement', conf: 'review', slide: x.slide });
        if (deckDir) {
          const sl = leaning(deckDir);
          add(101, `deck-wide: ${sl.length} of ${meas.length} content slides keep their content ${deckDir === 'top' ? 'pinned under the heading with the empty space at the bottom' : 'low with the empty space under the heading'} (slides ${sl.map((x) => x.slide).join(', ')}). Check for a deck-wide alignment rule.`, { key: 'placement-deck', conf: 'review', slides: sl.map((x) => x.slide) });
        }
      }
    }
    const blr = u.filter((s) => s.signature.bulletsLeftImageRight).map((s) => s.slide);
    if (blr.length >= 2) add(88, `bullets on the left and an image on the right on slides ${blr.join(', ')}`, { key: 'blr', slides: blr });
  }
  if (page.kind === 'web') {
    const secs = (u[0]?.signature.sections || []).slice(1, -1); // skip the hero and footer
    let run = 1, best = 1, at = 0;
    for (let i = 1; i < secs.length; i++) { if (secs[i].layout === secs[i - 1].layout && secs[i].layout) { run++; if (run > best) { best = run; at = i; } } else run = 1; }
    if (best >= 4) add(77, `${best} sections in a row share one layout (${secs[at].layout})`, { key: 'layout', conf: 'review' });
  }
  return out;
}

// Roll up per-slide hits that only matter as a deck-wide habit.
function rollUp(page, hits) {
  if (page.kind !== 'deck') return hits;
  const out = [];
  const bySlides = (p) => hits.filter((h) => h.p === p);
  for (const h of hits) if (![87, 4, 85].includes(h.p)) out.push(h);
  const centered = bySlides(87);
  if (centered.length) out.push({ ...centered[0], slide: centered.length === 1 ? centered[0].slide : null, slides: centered.map((h) => h.slide), ev: centered.length === 1 ? centered[0].ev : `text and bullets centered on ${centered.length} slides: ${centered.map((h) => h.slide).join(', ')}`, key: 'centered' });
  for (const p of [4, 85]) out.push(...bySlides(p));
  const same = hits.filter((h) => [4, 85, 74].includes(h.p) && (h.cov ?? 0) < 0.25);
  const slides = [...new Set(same.map((h) => h.slide))];
  if (slides.length >= 2) out.push({ p: 78, sel: null, text: null, ev: `equal boxes with near-equal text and nothing emphasized on slides ${slides.join(', ')}`, conf: 'review', key: 'same', slide: null, slides });
  return out;
}

function toFinding(page, h, check, src) {
  const pat = BY_N.get(h.p);
  const slideMode = page.kind === 'deck';
  return {
    pattern: h.p,
    name: (slideMode && pat.slides_name) || pat.name,
    check,
    confidence: pat.needs_confirming ? 'review' : (h.conf || 'high'),
    location: {
      page: page.label,
      slide: h.slide ?? null,
      slides: h.slides || null,
      selector: h.sel || null,
      line: page.file && h.sel ? lineFor(src, h) : (h.line || null),
    },
    evidence: h.ev,
    fix: pat.fix,
    key: `${h.p}|${page.label}|${h.slide ?? ''}|${h.key || h.sel || ''}`,
  };
}

function inScope(pat, kind) {
  return pat.scope === 'both' || (pat.scope === 'web' && kind === 'web') || (pat.scope === 'slides' && kind === 'deck');
}

function impeccableFindings(raw, pages, srcByFile) {
  const out = []; let other = 0;
  const byFile = new Map(pages.map((p) => [p.file || p.url, p]));
  for (const f of raw) {
    const n = IMPECCABLE_MAP[f.antipattern];
    const page = byFile.get(f.file) || byFile.get(f.url) || pages.find((p) => f.file && p.file && resolve(p.file) === resolve(f.file)) || (pages.length === 1 ? pages[0] : null);
    if (!n || !page) { other++; continue; }
    let p = n;
    if (f.antipattern === 'hero-eyebrow-chip' && /pill/i.test(f.snippet || '')) p = 2;
    const pat = BY_N.get(p);
    if (!inScope(pat, page.kind)) { if (p === 2) p = 1; else { other++; continue; } }
    // The first quoted text long enough to be unique (impeccable quotes "01" before the heading it sits beside).
    const quoted = [...(f.snippet || '').matchAll(/"([^"]+)"/g)].map((m) => m[1]).find((q) => q.length >= 4);
    let slide = null;
    if (page.kind === 'deck' && quoted) {
      const hitsIn = page.units.filter((x) => x.facts.copy.includes(quoted.slice(0, 40)));
      slide = hitsIn.length === 1 ? hitsIn[0].slide : null;
      if (hitsIn.length > 1) slide = 'ambiguous';
    }
    const src = srcByFile.get(page.file);
    // impeccable gives no selector and often no line, so find one in the source:
    // quoted text first, then a class name, color, font or CSS value from its snippet.
    const lines = src ? src.split('\n') : [];
    let line = f.line || null;
    if (!line && quoted && src) { const i = lines.findIndex((l) => l.includes(quoted.slice(0, 30))); line = i >= 0 ? i + 1 : null; }
    if (!line && src) {
      const snip = f.snippet || '';
      const tokens = [
        ...(snip.match(/^\.[\w-]+/) || []).map((c) => c + ' {'), ...(snip.match(/^\.[\w-]+/) || []),
        // A color only counts on a line that sets the same kind of property (text color or shadow).
        ...(snip.match(/#[0-9a-f]{6}\b/gi) || []).filter((c) => !/^#(ffffff|000000)$/i.test(c)).slice(0, 1).map((c) => {
          const rgb = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)).join(',\\s*');
          const prop = /glow|shadow/i.test(snip) ? 'shadow' : '(^|[^-])color';
          return new RegExp(`${prop}[^;]*(${c}|rgba?\\(\\s*${rgb})`, 'i');
        }),
        ...(/glow|shadow/i.test(snip) ? [] : (snip.match(/on (#[0-9a-f]{6})\b/i) || []).slice(1).map((c) => new RegExp(`background[^;]*${c}`, 'i'))),
        ...(snip.match(/border-(left|right): \d+px/g) || []).map((t) => t.replace(': ', ': ')),
        ...(snip.match(/Primary font: (\S+)/i) || []).slice(1).map((f2) => new RegExp('font-family:[^;]*' + f2, 'i')),
        ...(snip.match(/(\d+)px shadow blur/) || []).slice(1).map((n) => n + 'px'),
        ...(snip.match(/^(\d+)px body text/) || []).slice(1).map((n) => new RegExp(`font-size:\\s*${n}px`)),
        ...(/background-clip: text/.test(snip) ? ['background-clip: text', 'background-clip:text'] : []),
      ];
      for (const t of tokens) {
        const i = lines.findIndex((l) => (t instanceof RegExp ? t.test(l) : l.toLowerCase().includes(String(t).toLowerCase())));
        if (i >= 0) { line = i + 1; break; }
      }
    }
    // In a deck, a body line tells us the slide: count slide openings above it.
    const body0 = lines.findIndex((l) => /<body[\s>]/i.test(l));
    let slidesList = null;
    if (page.kind === 'deck' && !slide && line && src && line <= body0 + 1 && !page.customSlides) {
      const cls = (lines[line - 1].match(/\.([A-Za-z_][\w-]*)\s*[{,]/) || [])[1];
      const re = /<(section|div)\b[^>]*class="[^"]*\bslide\b/g;
      if (cls && (src.match(re) || []).length === page.units.length) {
        const uses = lines.map((l, i) => (i > body0 && new RegExp(`class="[^"]*\\b${cls}\\b`).test(l) ? i : -1)).filter((i) => i >= 0);
        const slidesOf = new Set(uses.map((i) => (lines.slice(0, i).join('\n').match(re) || []).length + ((lines[i].match(re) || []).length ? 1 : 0)));
        if (uses.length && slidesOf.size === 1) slide = [...slidesOf][0] || null;
        else if (slidesOf.size > 1) slidesList = [...slidesOf].filter(Boolean).sort((a, b) => a - b);
      }
    }
    if (slide === 'ambiguous') slide = null;
    else if (page.kind === 'deck' && !slide && line && src && !page.customSlides) {
      const body = lines.findIndex((l) => /<body[\s>]/i.test(l));
      if (line > body + 1) {
        // Count slide openings in the text before this line; only trust it when the
        // total in the file equals the number of slides found in the page.
        const re = /<(section|div)\b[^>]*class="[^"]*\bslide\b/g;
        const total = (src.match(re) || []).length;
        const before = (lines.slice(0, line - 1).join('\n').match(re) || []).length;
        const onLine = (lines[line - 1].match(re) || []).length;
        if (total === page.units.length && onLine <= 1 && before + onLine >= 1) slide = before + onLine;
      }
    }
    const at = line && lines[line - 1] ? ` [line ${line}: ${lines[line - 1].trim().slice(0, 90)}]` : '';
    // impeccable's advisory rules are softer calls, so they go to "confirm first".
    out.push(toFinding(page, { p, ev: `${f.snippet || f.name}${at} (impeccable: ${f.antipattern}${f.advisory ? ', advisory' : ''})`, slide, slides: slide ? null : slidesList, conf: f.advisory ? 'review' : 'high', key: f.antipattern + '|' + (f.snippet || ''), line }, 'impeccable', src));
  }
  return { findings: out, other };
}

// Drop impeccable's eyebrow/pill hit when the script already flagged the same pill: same page, same slide, the same text (compared without case), and the same line when both have one.
function dedupe(findings) {
  const seen = new Set(); const out = [];
  const pills = findings.filter((f) => f.pattern === 2 && f.check === 'script').map((f) => ({ text: f.evidence.match(/"([^"]+)"/)?.[1], page: f.location.page, slide: f.location.slide ?? null, line: f.location.line ?? null })).filter((x) => x.text);
  // Script checks that only back up an impeccable rule give way when impeccable found the pattern.
  const FALLBACK = [5, 6, 8, 11, 28, 33, 38, 40, 47, 49, 55, 57];
  const at = (f) => f.pattern + '|' + f.location.page + '|' + (f.location.slide ?? '');
  const impHas = new Set(findings.filter((f) => f.check === 'impeccable').map(at));
  for (const f of findings) {
    if (f.check === 'script' && FALLBACK.includes(f.pattern) && impHas.has(at(f))) {
      const imp = findings.find((g) => g.check === 'impeccable' && at(g) === at(f) && !g.location.selector);
      if (imp) { imp.location = { ...imp.location, selector: f.location.selector, line: imp.location.line || f.location.line }; imp.evidence += `; script: ${f.evidence}`; }
      continue;
    }
    if (f.check === 'impeccable' && [1, 2].includes(f.pattern) && pills.some((x) => x.page === f.location.page && x.slide === (f.location.slide ?? null) && !(x.line && f.location.line && x.line !== f.location.line) && f.evidence.toLowerCase().includes(x.text.slice(0, 20).toLowerCase()))) continue;
    if (seen.has(f.key)) continue;
    seen.add(f.key); out.push(f);
  }
  return out;
}

function judgementPack(report, pages, outDir) {
  const lines = [];
  lines.push('# Judgement pack', '', 'Read references/judgement-guide.md, then look at each screenshot and the facts below.',
    'Write your calls to `judgement.json` in this folder and run the merge command at the bottom.', '');
  const review = report.findings.filter((f) => f.confidence === 'review');
  if (review.length) {
    lines.push('## Script findings to confirm or dismiss', '');
    for (const f of review) lines.push(`- ${f.id}: #${f.pattern} ${f.name}, ${f.location.page}${f.location.slide ? ' slide ' + f.location.slide : ''}: ${f.evidence}`);
    lines.push('');
  }
  lines.push('## Patterns to judge', '');
  for (const n of report.judgementPatterns) { const p = BY_N.get(n); lines.push(`- #${n} ${p.name}: ${p.description}`); }
  lines.push('');
  for (const page of pages) {
    lines.push(`## ${page.label} (${page.kind === 'deck' ? page.units.length + ' slides' : 'web page'})`, '');
    for (const u of page.units) {
      if (u.slide) lines.push(`### Slide ${u.slide}`);
      if (u.screenshot) lines.push(`- Screenshot: ${u.screenshot}`);
      if (u.screenshotFull) lines.push(`- Full page (shrinks when viewed; use the close-ups to read detail): ${u.screenshotFull}${u.truncated ? ` (cut at 6000px of ${u.size.docH}px: judge the rest from the section close-ups)` : ''}`);
      if (u.crops && u.crops.length) { lines.push('- Close-ups at full size:'); for (const c of u.crops) lines.push(`  - ${c.kind} \`${c.sel}\`: ${c.path}${c.cut ? ' (first 1800px)' : ''}`); }
      const f = u.facts;
      if (f.h1) lines.push(`- h1: "${f.h1}"`);
      if (!u.slide && f.sections.length) {
        lines.push('- Sections in order:');
        for (const s of f.sections) lines.push(`  - \`${s.sel}\`: "${s.heading}" (${s.images} images${s.buttons.length ? ', buttons: ' + s.buttons.join(' / ') : ''})`);
      }
      if (f.images.length) { lines.push('- Images:'); for (const i of f.images) lines.push(`  - ${i.kind} ${i.size} at ${i.at} \`${i.sel}\` ${i.src ? 'src=' + i.src : ''} ${i.alt ? 'alt="' + i.alt + '"' : ''}`); }
      if (f.logos.length) lines.push(`- Logos: ${f.logos.map((l) => '`' + l.sel + '` ' + (l.src || l.alt)).join('; ')}`);
      if (f.modals.length) { lines.push('- Modals / dialogs:'); for (const m of f.modals) lines.push(`  - \`${m.sel}\` (${m.open ? 'open on load' : 'closed'}): "${m.text}"`); }
      if (f.numbers.length) { lines.push(`- Numbers on the page${f.numbers.length > 120 ? ' (first 120; read the copy and screenshots for the rest)' : ''}:`); for (const n of f.numbers.slice(0, 120)) lines.push(`  - ${n}`); }
      if (f.groupsOfThree.length) { lines.push('- Groups of exactly three:'); for (const g of f.groupsOfThree) lines.push(`  - ${g.map((x) => '"' + x + '"').join(' | ')}`); }
      const cap = u.slide ? 1500 : 4000;
      lines.push(`- Copy${f.copy.length > cap ? ` (first ${cap} characters)` : ''}: ${f.copy.slice(0, cap)}`, '');
    }
  }
  if (report.comparedTo && existsSync(report.comparedTo)) {
    const old = JSON.parse(readFileSync(report.comparedTo, 'utf8')).findings.filter((f) => f.check === 'judgement' && f.status !== 'dismissed');
    if (old.length) {
      lines.push('## Judgement findings from the last run', '', 'Look at each again. Put the ids still on the page in `still` in judgement.json; ids you leave out count as fixed.', '');
      for (const f of old) lines.push(`- ${f.id}: #${f.pattern} ${f.name}, ${f.location.page}${f.location.slide ? ' slide ' + f.location.slide : ''}: ${f.evidence}`);
      lines.push('');
    }
  }
  lines.push('## Merge', '', '```', `node ${join(HERE, 'check.mjs')} --merge ${join(outDir, 'judgement.json')} --report ${join(outDir, 'report.json')}`, '```', '');
  writeFileSync(join(outDir, 'judgement-pack.md'), lines.join('\n'));
  const tpl = join(outDir, 'judgement.json');
  if (!existsSync(tpl)) writeFileSync(tpl, JSON.stringify({ add: [], confirm: [], dismiss: [], judged: [], still: [] }, null, 2) + '\n');
}

function compareTo(report, oldPath) {
  const old = JSON.parse(readFileSync(oldPath, 'utf8'));
  // A recheck may scan a copy at another path: pair the pages up by order when the counts match.
  const same = old.targets.every((t) => report.targets.some((n) => n.page === t.page));
  if (!same && old.targets.length === 1 && report.targets.length === 1 && basename(old.targets[0].page) === basename(report.targets[0].page)) {
    report.notes = [...(report.notes || []).filter((n) => !n.startsWith('Recheck paired')), `Recheck paired ${old.targets[0].page} (last run) with ${report.targets[0].page} (this run).`];
    const rename = new Map(old.targets.map((t, i) => [t.page, report.targets[i].page]));
    for (const f of old.findings) {
      const was = f.location.page;
      if (rename.has(was)) { f.location = { ...f.location, page: rename.get(was) }; f.key = f.key.split('|').map((x, i) => (i === 1 && x === was ? rename.get(was) : x)).join('|'); }
    }
  }
  const loc = (f) => `${f.pattern}|${f.location.page}|${f.location.slide ?? ''}|${f.location.selector ?? ''}`;
  const oldLive = old.findings.filter((f) => f.status !== 'dismissed');
  const oldKeys = new Set(oldLive.map((f) => f.key)), oldLocs = new Set(oldLive.map(loc));
  for (const f of report.findings) f.recheck = (oldKeys.has(f.key) || oldLocs.has(loc(f))) ? 'still there' : 'new';
  const newKeys = new Set(report.findings.map((f) => f.key)), newLocs = new Set(report.findings.map(loc));
  // Gone from this run only counts as fixed when the same check really ran on that page this time.
  const ranOn = (f) => {
    const t = report.targets.find((x) => x.page === f.location.page);
    if (!t) return f.location.page.includes(', ') && report.ran.render; // cross-page drift findings
    if (f.check === 'impeccable') return report.ran.impeccable;
    if (f.check === 'judgement') return report.ran.judgement && (report.judged || []).includes(f.pattern);
    if (f.pattern === 79) return t.rendered && report.ran.brand;
    return t.rendered && report.ran.render;
  };
  const gone = oldLive.filter((f) => !newKeys.has(f.key) && !newLocs.has(loc(f))).map((f) => ({ id: f.id, pattern: f.pattern, name: f.name, location: f.location, check: f.check, evidence: f.evidence }));
  report.fixed = gone.filter(ranOn);
  report.unverified = gone.filter((f) => !ranOn(f));
  report.comparedTo = resolve(oldPath);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || (!opts.targets.length && !opts.merge)) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 19).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(opts.help ? 0 : 1);
  }
  if (opts.merge) {
    if (!opts.report) throw new Error('--merge needs --report <path to report.json>');
    const { mergeJudgement } = await import('./lib/report.mjs');
    const current = JSON.parse(readFileSync(opts.report, 'utf8'));
    const previous = current.comparedTo && existsSync(current.comparedTo) ? JSON.parse(readFileSync(current.comparedTo, 'utf8')) : null;
    const report = mergeJudgement(current, JSON.parse(readFileSync(opts.merge, 'utf8')), BY_N, previous);
    if (process.exitCode) { console.error('Nothing was merged. Fix the entries above and run the merge again.'); return; }
    if (report.comparedTo && existsSync(report.comparedTo)) compareTo(report, report.comparedTo);
    finalize(report, BY_N);
    writeFileSync(opts.report, JSON.stringify(report, null, 2));
    writeFileSync(join(dirname(opts.report), 'report.md'), renderMarkdown(report, BY_N));
    console.log(`Merged. ${report.count} findings. Report: ${join(dirname(resolve(opts.report)), 'report.md')}`);
    return;
  }

  const pages = expandTargets(opts.targets);
  const outDir = resolve(opts.out);
  mkdirSync(join(outDir, 'screenshots'), { recursive: true });
  const srcByFile = new Map(pages.filter((p) => p.file && existsSync(p.file)).map((p) => [p.file, readFileSync(p.file, 'utf8')]));

  const notes = [];
  let chromeOk = !!findChrome();
  const scanned = [];
  if (chromeOk) {
    const { browser, close } = await launchChrome();
    try {
      for (const p of pages) {
        try { const r = await scanPage(browser, p, opts, outDir); r.customSlides = !!opts.slideSelector; scanned.push(r); }
        catch (e) { notes.push(`Could not render ${p.label}: ${e.message}`); scanned.push({ ...p, kind: 'web', hits: [], units: [], failed: true }); }
      }
    } finally { await close(); }
  } else {
    notes.push('Chrome was not found, so the render checks and screenshots were skipped. Set CHROME_PATH.');
    for (const p of pages) scanned.push({ ...p, kind: opts.mode === 'slides' ? 'deck' : 'web', hits: [], units: [], failed: true });
  }

  let findings = [];
  for (const page of scanned) {
    const src = srcByFile.get(page.file);
    // Source-only check: tabs or slides switched on a timer (pattern 67).
    // A timer of a second or more next to code that switches tabs or slides.
    const timer = src && [...src.matchAll(/(setInterval|setTimeout)\s*\(([^;]{0,200}?),\s*(\d{4,})\s*\)/g)].find((m) => /(tab|slide|carousel|aria-selected|classList\.(toggle|add)\(['"]active)/i.test(src.slice(Math.max(0, m.index - 600), m.index + 600)));
    if (page.kind === 'web' && timer) {
      const line = src.slice(0, timer.index).split('\n').length;
      page.hits.push({ p: 67, sel: null, text: null, ev: `script switches tabs or slides on a timer (${timer[1]})`, conf: 'high', key: 'timer', line });
    }
    const hits = rollUp(page, [...page.hits, ...crossChecks(page)]);
    for (const h of hits) {
      const pat = BY_N.get(h.p);
      if (!pat || !inScope(pat, page.kind)) continue;
      findings.push(toFinding(page, h, 'script', src));
    }
  }
  // Pages and decks that drift from each other (pattern 14), when several pages are given.
  const webPages = scanned.filter((p) => p.kind === 'web' && p.units.length);
  if (webPages.length >= 2) {
    for (const field of [['titleFont', 'heading font'], ['bodyFont', 'body font'], ['buttonStyle', 'button style'], ['bg', 'page background']]) {
      const vals = new Map();
      for (const p of webPages) { let v = p.units[0].signature[field[0]]; if (!v) continue; if (field[0] === 'titleFont') v = v.split(' ').slice(0, -2).join(' '); vals.set(v, (vals.get(v) || []).concat(p.label)); }
      if (vals.size >= 2) findings.push(toFinding({ label: webPages.map((p) => p.label).join(', '), kind: 'web' }, { p: 14, ev: `${field[1]} changes between pages: ${[...vals].map(([v, ls]) => `${v.split('|')[0]} (${ls.join(', ')})`).join('; ')}`, key: field[0] }, 'script', null));
    }
  }

  let impeccableInfo = { ran: false };
  if (opts.impeccable) {
    const bin = findImpeccable();
    if (!bin) notes.push("impeccable's detector was not found, so the patterns it covers were not checked. Install the impeccable plugin or set IMPECCABLE_BIN.");
    else {
      try {
        const raw = runImpeccable(bin, scanned);
        const { findings: imp, other } = impeccableFindings(raw, scanned, srcByFile);
        findings.push(...imp);
        impeccableInfo = { ran: true, bin, otherFindings: other };
      } catch (e) { notes.push(e.message); }
    }
  } else notes.push('impeccable was turned off (--no-impeccable).');

  findings = dedupe(findings).filter((f) => !scanned.find((p) => p.label === f.location.page)?.failed || f.check === 'impeccable');
  const kinds = new Set(scanned.map((p) => p.kind));
  const report = {
    tool: 'design-slop-check', version: 1, created: new Date().toISOString(),
    targets: scanned.map((p) => ({ page: p.label, kind: p.kind, slides: p.kind === 'deck' ? p.units.length : null, rendered: !p.failed, placement: p.kind === 'deck' ? !!p.placementRan : null, errors: p.errors || [] })),
    options: { mode: opts.mode, viewport: opts.viewport, slideViewport: opts.slideViewport, brand: opts.brand },
    ran: { render: chromeOk && scanned.some((p) => !p.failed), impeccable: impeccableInfo.ran, judgement: false, brand: opts.brand.length > 0, placement: scanned.some((p) => p.kind === 'deck' && p.placementRan) },
    impeccableOtherFindings: impeccableInfo.otherFindings || 0,
    notes,
    kinds: [...kinds],
    findings,
    judgementPatterns: PATTERNS.filter((p) => p.checked_by.includes('judgement') && [...kinds].some((k) => inScope(p, k))).map((p) => p.n),
  };
  if (opts.compare) compareTo(report, opts.compare);
  finalize(report, BY_N);
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, 'report.md'), renderMarkdown(report, BY_N));
  judgementPack(report, scanned, outDir);
  if (scanned.some((p) => p.kind === 'deck')) console.log(`Read as: ${scanned.map((p) => p.kind === 'deck' ? `deck of ${p.units.length} slides` : 'web page').join(', ')}. If that is wrong, rerun with --mode web or --mode slides.`);
  console.log(`${report.count} findings (${report.findings.filter((f) => f.confidence === 'review').length} to confirm) on ${scanned.length} target(s).`);
  console.log(`Report:          ${join(outDir, 'report.md')}`);
  console.log(`JSON:            ${join(outDir, 'report.json')}`);
  console.log(`Judgement pack:  ${join(outDir, 'judgement-pack.md')}`);
  for (const n of notes) console.log('Note: ' + n);
}

main().catch((e) => { console.error('design-slop-check: ' + e.message); process.exit(1); });

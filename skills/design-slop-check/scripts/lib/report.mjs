// Builds the fix list: ids, counts, coverage, judgement merge and markdown.

const inScope = (pat, kinds) => kinds.some((k) => pat.scope === 'both' || (pat.scope === 'web' && k === 'web') || (pat.scope === 'slides' && k === 'deck'));
const live = (f) => f.status !== 'dismissed';

export function finalize(report, BY_N) {
  report.findings.sort((a, b) => a.pattern - b.pattern
    || String(a.location.page).localeCompare(String(b.location.page))
    || (a.location.slide ?? 0) - (b.location.slide ?? 0));
  let next = Math.max(0, ...report.findings.map((f) => +(f.id || 'F0').slice(1) || 0)) + 1;
  for (const f of report.findings) if (!f.id) f.id = 'F' + String(next++).padStart(3, '0');
  const L = report.findings.filter(live);
  report.count = L.length;
  report.patternsFound = [...new Set(L.map((f) => f.pattern))].length;
  report.byCheck = { script: 0, impeccable: 0, judgement: 0 };
  for (const f of L) report.byCheck[f.check] = (report.byCheck[f.check] || 0) + 1;
  report.toConfirm = L.filter((f) => f.confidence === 'review').length;

  const judged = new Set(report.judged || []);
  const coverage = [];
  const failed = report.targets.filter((t) => !t.rendered).map((t) => t.page);
  // Script backups for some impeccable rules still run when impeccable is missing.
  const FALLBACK = new Set([5, 6, 8, 11, 28, 33, 38, 40, 47, 49, 55, 57]);
  const PARTIAL = { 65: 'same-origin images only', 72: 'SVG and HTML charts only, not canvas' };
  const webRendered = report.targets.filter((t) => t.kind === 'web' && t.rendered).length;
  for (const pat of BY_N.values()) {
    if (!inScope(pat, report.kinds)) { coverage.push({ n: pat.n, status: 'not in scope' }); continue; }
    if (L.some((f) => f.pattern === pat.n)) { coverage.push({ n: pat.n, status: 'found' }); continue; }
    const reasons = [];
    let checked = false;
    if (pat.checked_by.includes('script')) {
      if (pat.n === 79 && !report.ran.brand) reasons.push('needs brand colors (run with --brand "#hex,#hex")');
      else if (pat.n === 14 && webRendered < 2 && !report.kinds.includes('deck')) reasons.push('needs two or more rendered pages (give a folder)');
      else if (pat.n === 101 && !report.ran.placement) reasons.push('needs 4 or more comparable content slides in a deck');
      else if (pat.n === 78 && !report.kinds.includes('deck')) reasons.push('the script check runs on decks only; judge it by eye on web pages');
      else if (report.ran.render) checked = true; else reasons.push('render pass did not run');
    }
    let partly = null;
    if (pat.checked_by.includes('impeccable')) {
      if (report.ran.impeccable) checked = true;
      else if ((FALLBACK.has(pat.n) || pat.checked_by.includes('script')) && report.ran.render) { checked = true; partly = "impeccable's detector did not run; only the script's narrower check did"; }
      else reasons.push("impeccable's detector did not run");
    }
    if (pat.checked_by.includes('judgement')) { if (judged.has(pat.n)) checked = true; else reasons.push('needs the judgement review'); }
    if (checked && failed.length && pat.checked_by.includes('script')) partly = `not rendered: ${failed.join(', ')}`;
    if (checked && PARTIAL[pat.n]) partly = PARTIAL[pat.n];
    if (checked && pat.n === 101) { const skipped = report.targets.filter((t) => t.kind === 'deck' && t.rendered && t.placement === false).map((t) => t.page); if (skipped.length) partly = `not checked on decks with fewer than 4 comparable content slides: ${skipped.join(', ')}`; }
    const why = report.judgedReasons && report.judgedReasons[pat.n];
    coverage.push(checked ? { n: pat.n, status: partly ? 'partly checked' : 'clear', ...(partly ? { reason: partly } : {}), ...(why ? { judgedReason: why } : {}) } : { n: pat.n, status: 'not checked', reason: reasons.join('; ') });
  }
  report.coverage = coverage;
  return report;
}

const KEYS = new Set(['add', 'confirm', 'dismiss', 'judged', 'still']);

export function mergeJudgement(report, j, BY_N, previous = null) {
  report = structuredClone(report); // the caller saves only a clean merge
  const problems = [];
  if (!j || typeof j !== 'object' || Array.isArray(j)) { console.error('judgement.json must be an object'); process.exitCode = 1; return report; }
  for (const k of ['add', 'confirm', 'dismiss', 'judged', 'still']) if (j[k] !== undefined && !Array.isArray(j[k])) problems.push(`"${k}" must be a list`);
  const bad = (k, ok) => (j[k] || []).filter((x) => !ok(x)).forEach((x) => problems.push(`${k}: bad entry ${JSON.stringify(x)}`));
  bad('add', (x) => x && typeof x === 'object' && !Array.isArray(x));
  bad('dismiss', (x) => x && typeof x === 'object' && typeof x.id === 'string');
  bad('confirm', (x) => typeof x === 'string');
  bad('still', (x) => typeof x === 'string');
  bad('judged', (x) => typeof x === 'number' || (x && typeof x === 'object' && x.pattern !== undefined));
  if (problems.length) { console.error('Some judgement entries were not merged:\n- ' + problems.join('\n- ')); process.exitCode = 1; return report; }
  for (const k of Object.keys(j)) if (!KEYS.has(k)) problems.push(`unknown key "${k}" (use add, confirm, dismiss, judged, still)`);
  const byId = new Map(report.findings.map((f) => [f.id, f]));
  const both = new Set((j.confirm || []).filter((id) => (j.dismiss || []).some((d) => d.id === id)));
  for (const id of both) problems.push(`${id} is both confirmed and dismissed; pick one`);
  j = { ...j, confirm: (j.confirm || []).filter((id) => !both.has(id)), dismiss: (j.dismiss || []).filter((d) => !both.has(d.id)) };
  const pages = new Map(report.targets.map((t) => [t.page, t]));
  for (const d of j.dismiss || []) {
    const f = byId.get(d.id);
    if (!f) { problems.push(`dismiss: no finding ${d.id}`); continue; }
    if (!d.reason) { problems.push(`dismiss ${d.id}: give a reason`); continue; }
    f.status = 'dismissed'; f.dismissReason = d.reason;
  }
  for (const id of j.confirm || []) {
    const f = byId.get(id);
    if (!f) { problems.push(`confirm: no finding ${id}`); continue; }
    f.confidence = 'high'; f.confirmed = true;
  }
  const existing = new Set(report.findings.map((f) => f.key));
  const accepted = [];
  for (const a of j.add || []) {
    const pat = BY_N.get(+a.pattern);
    if (!pat) { problems.push(`add: unknown pattern ${a.pattern}`); continue; }
    if (typeof a.evidence !== 'string' || !a.evidence.trim()) { problems.push(`add #${pat.n}: evidence (text) is required`); continue; }
    if (a.page && !pages.has(a.page)) { problems.push(`add #${pat.n}: page "${a.page}" is not in this report (use one of: ${[...pages.keys()].join(', ')})`); continue; }
    const page = a.page || report.targets[0].page;
    const tgt = pages.get(page);
    const sl = [a.slide, ...(a.slides || [])].filter((x) => x !== undefined && x !== null);
    if (sl.length && tgt.kind !== 'deck') { problems.push(`add #${pat.n}: ${page} is a web page, so it has no slides`); continue; }
    if (sl.some((x) => typeof x !== 'number' || !Number.isInteger(x) || x < 1 || x > tgt.slides)) { problems.push(`add #${pat.n}: slide must be a number from 1 to ${tgt.slides}`); continue; }
    if (!inScope(pat, [tgt.kind])) { problems.push(`add: #${pat.n} does not apply to ${tgt.kind === 'deck' ? 'decks' : 'web pages'} (${page})`); continue; }
    accepted.push(pat.n);
    const key = `${pat.n}|${page}|${a.slide ?? ''}|judged:${a.selector || a.evidence.slice(0, 40)}`;
    if (existing.has(key)) continue;
    existing.add(key);
    report.findings.push({
      pattern: pat.n,
      name: (report.kinds.includes('deck') && pat.slides_name) || pat.name,
      check: 'judgement',
      confidence: 'high',
      location: { page, slide: a.slide ?? null, slides: a.slides || null, selector: a.selector || null, line: a.line || null },
      evidence: a.evidence,
      fix: a.fix || pat.fix,
      key,
    });
  }
  // Last run's judgement findings the reviewer saw again: carried over with their keys, so the recheck pairs them.
  if ((j.still || []).length) {
    const old = new Map((previous ? previous.findings : []).map((f) => [f.id, f]));
    for (const id of j.still) {
      const f = old.get(id);
      if (!f || f.check !== 'judgement') { problems.push(`still: ${id} is not a judgement finding in the last run`); continue; }
      if (existing.has(f.key)) continue;
      existing.add(f.key);
      const { id: _drop, recheck: _r, status: _s, ...rest } = f;
      report.findings.push({ ...rest, location: { ...f.location, page: pages.has(f.location.page) ? f.location.page : report.targets[0].page } });
    }
  }
  // judged: pattern numbers, or {pattern, reason} so the report shows why each was cleared.
  report.judgedReasons = report.judgedReasons || {};
  const judgedNums = [];
  for (const x of j.judged || []) {
    const n = typeof x === 'object' ? +x.pattern : +x;
    if (!BY_N.has(n)) { problems.push(`judged: unknown pattern ${JSON.stringify(x)}`); continue; }
    judgedNums.push(n);
    if (typeof x === 'object' && x.reason) report.judgedReasons[n] = x.reason;
  }
  const judged = new Set([...(report.judged || []), ...judgedNums, ...accepted]);
  report.judged = [...judged].sort((a, b) => a - b);
  const noReason = judgedNums.filter((n) => !report.judgedReasons[n] && !accepted.includes(n));
  if (noReason.length) console.error(`Judged with no reason (add one line for each pattern you cleared, so the report can show what was looked at): ${[...new Set(noReason)].map((n) => '#' + n).join(', ')}`);
  const open = report.findings.filter((f) => f.confidence === 'review' && f.status !== 'dismissed' && !f.confirmed).map((f) => f.id);
  if (open.length) console.error(`Still marked "confirm first" (confirm or dismiss them): ${open.join(', ')}`);
  report.ran.judgement = true;
  if (problems.length) {
    console.error('Some judgement entries were not merged:\n- ' + problems.join('\n- '));
    process.exitCode = 1;
  }
  return report;
}

function where(f) {
  const l = f.location;
  const bits = [l.page];
  if (l.slide) bits.push(`slide ${l.slide}`);
  else if (l.slides && l.slides.length) bits.push(`slides ${l.slides.join(', ')}`);
  if (l.selector) bits.push('`' + l.selector + '`');
  if (l.line) bits.push(`line ${l.line}`);
  return bits.join(', ');
}

export function renderMarkdown(report, BY_N) {
  const L = report.findings.filter(live);
  const out = [];
  const targets = report.targets.map((t) => t.page + (t.slides ? ` (${t.slides} slides)` : '')).join(', ');
  out.push(`# Design slop check: ${targets}`, '');
  out.push(`Read as: ${report.targets.map((t) => (t.kind === 'deck' ? `a deck of ${t.slides} slides` : 'a web page')).join('; ')}. If that is wrong, run again with --mode web or --mode slides.`, '');
  const src = Object.entries(report.byCheck).filter(([, n]) => n).map(([k, n]) => `${n} from ${k === 'script' ? 'the scripts' : k === 'impeccable' ? "impeccable's detector" : 'the judgement review'}`).join(', ');
  out.push(`**${report.count} finding${report.count === 1 ? '' : 's'}** across ${report.patternsFound} pattern${report.patternsFound === 1 ? '' : 's'}${src ? ` (${src})` : ''}.` + (report.toConfirm ? ` ${report.toConfirm} marked "confirm first" need a look before fixing.` : ''));
  if (report.comparedTo) {
    const still = L.filter((f) => f.recheck === 'still there').length, fresh = L.filter((f) => f.recheck === 'new').length;
    out.push('', `**Recheck against the last run:** ${report.fixed.length} fixed, ${still} still there, ${fresh} new.`);
  }
  const notChecked = report.coverage.filter((c) => c.status === 'not checked');
  if (notChecked.length) out.push('', `${notChecked.length} pattern${notChecked.length === 1 ? '' : 's'} not checked yet (listed at the end).`);
  out.push('', '## Fix list', '');
  if (!L.length) out.push('Nothing on the list was found.', '');
  let lastP = null;
  for (const f of L) {
    if (f.pattern !== lastP) {
      const n = L.filter((x) => x.pattern === f.pattern).length;
      if (lastP !== null) out.push('');
      out.push(`### #${f.pattern} ${f.name} (${n} place${n === 1 ? '' : 's'})`, '');
      out.push(`> ${BY_N.get(f.pattern).description}`, '');
      lastP = f.pattern;
    }
    const tags = [f.check === 'impeccable' ? 'impeccable' : f.check === 'judgement' ? 'judgement' : 'script'];
    if (f.confidence === 'review') tags.push('confirm first');
    if (f.recheck) tags.push(f.recheck);
    out.push(`- **${f.id}** [${tags.join(', ')}] ${where(f)}`);
    out.push(`  - Evidence: ${f.evidence}`);
    out.push(`  - Fix: ${f.fix}`);
  }
  out.push('');
  if (report.fixed && report.fixed.length) {
    out.push('## Fixed since the last run', '');
    for (const f of report.fixed) out.push(`- ${f.id} #${f.pattern} ${f.name}, ${where(f)}${f.check === 'judgement' ? ' (judgement: confirm by eye)' : ''}`);
    out.push('');
  }
  if (report.unverified && report.unverified.length) {
    out.push('## Gone, but not verified', '', 'These are not in this run, but the check that found them did not run this time, so they are not counted as fixed.', '');
    for (const f of report.unverified) out.push(`- ${f.id} #${f.pattern} ${f.name}, ${where(f)} (${f.check})`);
    out.push('');
  }
  const dis = report.findings.filter((f) => !live(f));
  if (dis.length) {
    out.push('## Dismissed after review', '');
    for (const f of dis) out.push(`- ${f.id} #${f.pattern} ${f.name}, ${where(f)}: ${f.dismissReason}`);
    out.push('');
  }
  out.push('## Coverage', '');
  const clear = report.coverage.filter((c) => c.status === 'clear' && !c.judgedReason).map((c) => '#' + c.n);
  out.push(`- Found: ${report.coverage.filter((c) => c.status === 'found').map((c) => '#' + c.n).join(' ') || 'none'}`);
  out.push(`- Checked, nothing found: ${clear.join(' ') || 'none'}`);
  const partly = report.coverage.filter((c) => c.status === 'partly checked');
  if (partly.length) { out.push('- Partly checked, nothing found:'); for (const c of partly) out.push(`  - #${c.n} ${BY_N.get(c.n).name}: ${c.reason}`); }
  const why = report.coverage.filter((c) => c.judgedReason);
  if (why.length) { out.push('- Judged clear by eye:'); for (const c of why) out.push(`  - #${c.n} ${BY_N.get(c.n).name}: ${c.judgedReason}`); }
  const scope = report.coverage.filter((c) => c.status === 'not in scope').map((c) => '#' + c.n);
  if (scope.length) out.push(`- Not on the list for ${report.kinds.includes('deck') && !report.kinds.includes('web') ? 'slides' : 'web pages'}: ${scope.join(' ')}`);
  if (notChecked.length) {
    out.push('- Not checked:');
    for (const c of notChecked) out.push(`  - #${c.n} ${BY_N.get(c.n).name}: ${c.reason}`);
  }
  if (report.impeccableOtherFindings) out.push(`- impeccable also raised ${report.impeccableOtherFindings} general quality issue(s) that are not on this list. Run \`impeccable detect\` to see them.`);
  for (const n of report.notes || []) out.push(`- Note: ${n}`);
  const errs = report.targets.filter((t) => t.errors && t.errors.length);
  for (const t of errs) out.push(`- Script errors on ${t.page}: ${t.errors.slice(0, 3).join(' | ')}`);
  out.push('');
  return out.join('\n');
}

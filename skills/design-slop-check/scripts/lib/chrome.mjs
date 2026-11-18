// Minimal headless Chrome driver over the DevTools protocol.
// Uses Node's built-in WebSocket (Node 22+), so nothing needs installing.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

export function findChrome() {
  return CANDIDATES.find((p) => existsSync(p)) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchChrome({ chromePath, timeoutMs = 20000 } = {}) {
  const bin = chromePath || findChrome();
  if (!bin) throw new Error('Chrome not found. Set CHROME_PATH to a Chrome or Chromium binary.');
  const profile = mkdtempSync(join(tmpdir(), 'dsc-chrome-'));
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-sync',
    '--hide-scrollbars', '--mute-audio', '--allow-file-access-from-files',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
  ];
  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '', spawnError = null;
  proc.on('error', (e) => { spawnError = e; });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  // Kill Chrome and remove its profile whatever state it is in.
  const exited = new Promise((r) => { if (proc.exitCode !== null) r(); else proc.once('exit', r); });
  // Kill Chrome, wait for it to exit (bounded), then remove the profile, retrying while files are released.
  const hardStop = async () => {
    try { proc.kill('SIGKILL'); } catch { /* exited */ }
    await Promise.race([exited, sleep(3000)]);
    for (let i = 0; i < 5; i++) {
      try { rmSync(profile, { recursive: true, force: true }); if (!existsSync(profile)) return; } catch { /* retry */ }
      await sleep(200);
    }
  };
  let browser;
  try {
    const portFile = join(profile, 'DevToolsActivePort');
    const start = Date.now();
    while (!existsSync(portFile)) {
      if (spawnError) throw new Error('Chrome could not start: ' + spawnError.message);
      if (Date.now() - start > timeoutMs) throw new Error('Chrome did not start in time. ' + stderr.slice(-400));
      await sleep(100);
    }
    await sleep(50);
    const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
    browser = await connect(`ws://127.0.0.1:${port}${path}`);
  } catch (e) { await hardStop(); throw e; }
  const close = async () => {
    await Promise.race([browser.send('Browser.close').catch(() => {}), sleep(2000)]);
    try { browser.ws.close(); } catch { /* closed */ }
    await hardStop();
  };
  return { browser, close };
}

// Every DevTools command gets a deadline, and a dropped connection fails all
// pending commands, so a stuck page can never hang the run.
function connect(url, commandTimeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const connectTimer = setTimeout(() => { try { ws.close(); } catch { /* */ } reject(new Error('DevTools connection timed out')); }, 10000);
    let id = 0;
    const pending = new Map();
    const listeners = new Set();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
      } else {
        for (const l of listeners) l(msg);
      }
    };
    ws.onerror = () => { clearTimeout(connectTimer); reject(new Error('DevTools connection failed')); };
    ws.onclose = () => { for (const { rej } of pending.values()) rej(new Error('DevTools connection closed')); pending.clear(); };
    ws.onopen = () => {
      clearTimeout(connectTimer);
      const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
        const mid = ++id;
        const timer = setTimeout(() => { pending.delete(mid); rej(new Error(`DevTools command ${method} timed out`)); }, commandTimeoutMs);
        pending.set(mid, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
        try { ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) })); } catch (e) { pending.delete(mid); clearTimeout(timer); rej(e); }
      });
      resolve({ ws, send, on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } });
    };
  });
}

// Opens a page in its own target and returns helpers bound to its session.
export async function openPage(browser, { width, height }) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (m, p) => browser.send(m, p, sessionId);
  const errors = [];
  browser.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || 'error');
    }
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  const waitForLoad = (timeoutMs) => new Promise((resolve) => {
    let done = false;
    const off = browser.on((msg) => {
      if (msg.sessionId === sessionId && msg.method === 'Page.loadEventFired' && !done) {
        done = true; off(); resolve(true);
      }
    });
    setTimeout(() => { if (!done) { done = true; off(); resolve(false); } }, timeoutMs);
  });

  return {
    errors,
    async goto(url, timeoutMs = 20000) {
      const loaded = waitForLoad(timeoutMs);
      const nav = await send('Page.navigate', { url });
      if (nav.errorText) throw new Error(`Could not open ${url}: ${nav.errorText}`);
      const ok = await loaded;
      // Let web fonts and first-frame scripts settle.
      await this.evaluate('Promise.race([document.fonts ? document.fonts.ready.then(() => true) : true, new Promise((r) => setTimeout(() => r(false), 3000))])');
      await sleep(400);
      return ok;
    },
    async evaluate(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) {
        throw new Error('Page script failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      }
      return r.result.value;
    },
    async screenshot({ fullPage = false, maxHeight = 6000, clip = null } = {}) {
      const params = { format: 'png' };
      if (clip) { params.captureBeyondViewport = true; params.clip = { ...clip, scale: 1 }; }
      if (fullPage) {
        const h = await this.evaluate('Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)');
        params.captureBeyondViewport = true;
        params.clip = { x: 0, y: 0, width, height: Math.min(h || height, maxHeight), scale: 1 };
      }
      const { data } = await send('Page.captureScreenshot', params);
      return Buffer.from(data, 'base64');
    },
    sleep,
    async close() { try { await browser.send('Target.closeTarget', { targetId }); } catch { /* gone */ } },
  };
}

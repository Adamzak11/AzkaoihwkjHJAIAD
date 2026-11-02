// Ujian hujung-ke-hujung dengan Playwright (Chromium). Pengguna:
//   npm run fixtures && node tests/e2e.mjs [senario...]
// Senario: normal30, normal60, segment, ab, image, hevc  (lalai: semua)
// CORE=local -> layan @ffmpeg/core dari node_modules (tanpa internet); lalai guna unpkg sebenar.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from '../scripts/serve.mjs';

// Playwright: guna yang dipasang dalam projek, atau yang global (createRequire ikut NODE_PATH).
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const here = fileURLToPath(new URL('.', import.meta.url));
const FX = here + 'fixtures/';
const OUT = here + 'out/';
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.PORT || 8099);
const all = ['normal30', 'normal60', 'segment', 'ab', 'image', 'hevc'];
const scenarios = process.argv.slice(2).length ? process.argv.slice(2) : all;

function ffprobe(file) {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]).toString());
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  const [n, d] = v.avg_frame_rate.split('/').map(Number);
  return { codec: v.codec_name, profile: v.profile, level: v.level, pix: v.pix_fmt, w: v.width, h: v.height, fps: +(n / d).toFixed(2),
    dur: +(+j.format.duration).toFixed(2), kbps: Math.round(j.format.bit_rate / 1000), audio: a ? `${a.codec_name} ${Math.round(a.bit_rate / 1000)}k ${a.channels}ch` : 'tiada',
    faststart: moovFirst(file) };
}
function moovFirst(file) {
  const b = readFileSync(file);
  let off = 0;
  while (off + 8 <= b.length) {
    const size = b.readUInt32BE(off); const type = b.toString('latin1', off + 4, off + 8);
    if (type === 'moov') return true; if (type === 'mdat') return false;
    if (size < 8) break; off += size;
  }
  return false;
}

const srv = await startServer(PORT);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true, isMobile: true, hasTouch: true });
if (process.env.CORE === 'local') {
  const coreDir = process.env.CORE_DIR || fileURLToPath(new URL('../node_modules/@ffmpeg/core/dist/esm/', import.meta.url));
  await ctx.route(/unpkg\.com\/@ffmpeg\/core@0\.12\.10\/dist\/esm\/(.*)$/, (route) => {
    const f = route.request().url().split('/').pop();
    route.fulfill({ path: coreDir + f, headers: { 'Content-Type': f.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', 'Access-Control-Allow-Origin': '*' } });
  });
}
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('  [console]', m.text()); });
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
page.on('dialog', (d) => d.accept());

async function fresh() {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('#processBtn');
}
async function pick(files) {
  await page.setInputFiles('#fileInput', files.map((f) => FX + f));
  await page.waitForFunction((n) => document.querySelectorAll('#fileList li').length === n
    && ![...document.querySelectorAll('#fileList li')].some((li) => /Membaca|Menunggu/.test(li.textContent)), files.length, { timeout: 180000 });
  const list = await page.$$eval('#fileList li', (ls) => ls.map((l) => l.innerText.replace(/\s+/g, ' ').trim()));
  list.forEach((l) => console.log('  fail:', l));
}
async function run() {
  const t = Date.now();
  await page.click('#processBtn');
  if (await page.locator('#confirmDlg[open]').count()) {
    console.log('  dialog:', (await page.innerText('#dlgBody')).replace(/\s+/g, ' '));
    await page.click('#dlgOk');
  }
  await page.waitForFunction(() => !document.querySelector('#progressBox').hidden || document.querySelectorAll('.result,#messages .msg').length, null, { timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#progressBox').hidden && !document.querySelector('#processBtn').disabled, null, { timeout: 60 * 60 * 1000, polling: 1000 });
  console.log(`  siap dalam ${((Date.now() - t) / 1000).toFixed(0)}s`);
  const msgs = await page.$$eval('#messages .msg', (ms) => ms.map((m) => m.innerText.replace(/\s+/g, ' ').slice(0, 300)));
  msgs.forEach((m) => console.log('  mesej:', m));
}
async function collect(tag) {
  const cards = await page.$$('.result');
  const out = [];
  for (const c of cards) {
    const label = (await c.$eval('.res-label', (e) => e.textContent));
    const meta = (await c.$eval('.meta', (e) => e.innerText.replace(/\n/g, ' ')));
    const [dl] = await Promise.all([page.waitForEvent('download'), (await c.$('[data-act=dl]')).click()]);
    const path = OUT + tag + '__' + dl.suggestedFilename();
    await dl.saveAs(path);
    const info = /\.jpg$/.test(path) ? execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,codec_name', '-of', 'csv=p=0', path]).toString().trim() : ffprobe(path);
    console.log(`  HASIL ${label}\n     UI : ${meta}\n     fail: ${dl.suggestedFilename()}\n     ffprobe: ${JSON.stringify(info)}`);
    out.push({ label, meta, info, name: dl.suggestedFilename() });
  }
  if (await page.locator('#abTableWrap:not([hidden])').count()) {
    console.log('  Jadual A/B:\n' + (await page.innerText('#abTable')).split('\n').map((l) => '     ' + l).join('\n'));
  }
  return out;
}
async function setRadio(name, value) { await page.click(`input[name=${name}][value="${value}"] + span`); }

const results = {};
for (const s of scenarios) {
  console.log(`\n=== ${s} ===`);
  await fresh();
  if (s === 'normal30') {
    await pick(['v15_30.mp4', 'v15_60.mp4']);
    console.log('  60fps dibenarkan:', !(await page.isDisabled('input[name=fps][value="60"]')));
    await setRadio('fps', '30');
    await run();
    results[s] = await collect(s);
  } else if (s === 'normal60') {
    await pick(['v15_60.mp4', 'v15_30.mp4']);
    await setRadio('fps', '60'); await setRadio('profile', 'tajam');
    await run();
    results[s] = await collect(s);
  } else if (s === 'segment') {
    await pick(['v60_30.mp4']);
    await page.check('#segmentChk');
    await run();
    results[s] = await collect(s);
  } else if (s === 'segment60') {
    await pick(['v60_60.mp4']);
    await setRadio('fps', '60');
    await page.check('#segmentChk');
    await run();
    results[s] = await collect(s);
  } else if (s === 'full60') {
    await pick(['v60_60.mp4']);
    await setRadio('fps', '60');
    await run();
    results[s] = await collect(s);
  } else if (s === 'ab') {
    await pick(['v15_60.mp4']);
    await page.click('.switch .slider');
    await page.click('input[name=abFps][value="60"] + span');
    console.log('  ', await page.innerText('#abSummary'));
    await run();
    results[s] = await collect(s);
    await page.screenshot({ path: OUT + 'ab-results.png', fullPage: true });
  } else if (s === 'image') {
    await pick(['img_4032x3024.jpg']);
    await run();
    results[s] = await collect(s);
  } else if (s === 'hevc') {
    await pick(['v5_4k_hevc.mov']);
    await run();
    results[s] = await collect(s);
  } else if (s === 'ab30only') {
    await pick(['v15_30.mp4']);
    await page.click('.switch .slider');
    console.log('  60fps A/B dibenarkan:', !(await page.isDisabled('#abFps60')));
    console.log('  ', await page.innerText('#abSummary'));
  } else if (s === 'shot') {
    await page.screenshot({ path: OUT + 'home.png', fullPage: true });
  }
}
await page.screenshot({ path: OUT + 'last.png', fullPage: true });
await browser.close();
srv.close();

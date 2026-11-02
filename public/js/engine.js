// Pembalut ffmpeg.wasm (versi single-thread).
// - @ffmpeg/ffmpeg 0.12.15 di-host sendiri dalam /vendor (supaya Worker sama-origin).
// - @ffmpeg/core 0.12.10 (ESM, single-thread) dimuat hanya bila perlu, dengan progress.
import { FFmpeg } from '../vendor/ffmpeg-0.12.15/index.js';

export const FFMPEG_VERSION = '0.12.15';
export const CORE_VERSION = '0.12.10';

// Saiz sebenar fail dalam pakej @ffmpeg/core@0.12.10 (untuk progress bila
// Content-Length tiada atau dimampatkan oleh CDN).
const CORE_JS_SIZE = 111804;
const CORE_WASM_SIZE = 32232419;

// Sumber core ikut turutan. Salinan tempatan (pilihan) dicuba dahulu: jalankan
// `npm run vendor-core` untuk host sendiri. jsDelivr TIDAK digunakan kerana ia
// tidak melayan fail > 20 MB (wasm ini ~32 MB).
const CORE_SOURCES = [
  { name: 'salinan tempatan', base: new URL(`../vendor/core-${CORE_VERSION}/`, import.meta.url).href, optional: true },
  { name: 'unpkg', base: `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm/` },
];

let ff = null;
let loadingPromise = null;
let coreURLs = null; // { coreURL, wasmURL } blob URL, disimpan untuk muat semula pantas
let logSink = null;
const logTail = [];

export function isLoaded() { return !!(ff && ff.loaded); }
export function lastLogs(n = 25) { return logTail.slice(-n).join('\n'); }

async function fetchWithProgress(url, expected, onChunk) {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status} untuk ${url}`);
  const type = res.headers.get('content-type') || '';
  if (url.endsWith('.js') && type.includes('text/html')) throw new Error('Bukan fail JS');
  if (!res.body || !res.body.getReader) {
    const b = await res.blob();
    onChunk(b.size);
    return b;
  }
  const reader = res.body.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    onChunk(value.byteLength);
  }
  return new Blob(parts);
}

async function downloadCore(onProgress) {
  let lastErr;
  for (const src of CORE_SOURCES) {
    try {
      if (src.optional) {
        const head = await fetch(src.base + 'ffmpeg-core.wasm', { method: 'HEAD' }).catch(() => null);
        if (!head || !head.ok) continue;
      }
      const total = CORE_JS_SIZE + CORE_WASM_SIZE;
      let got = 0;
      const tick = (n) => { got += n; onProgress?.(Math.min(1, got / total), src.name); };
      const js = await fetchWithProgress(src.base + 'ffmpeg-core.js', CORE_JS_SIZE, tick);
      const wasm = await fetchWithProgress(src.base + 'ffmpeg-core.wasm', CORE_WASM_SIZE, tick);
      if (wasm.size < 1_000_000) throw new Error('Fail wasm tidak lengkap');
      return {
        coreURL: URL.createObjectURL(new Blob([js], { type: 'text/javascript' })),
        wasmURL: URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' })),
      };
    } catch (e) {
      lastErr = e;
      console.warn('Gagal muat core dari', src.name, e);
    }
  }
  throw new Error('Tidak dapat memuat enjin video. Semak sambungan internet. (' + (lastErr?.message || lastErr) + ')');
}

/** Muat enjin (sekali sahaja). onProgress(ratio 0..1, sumber, fasa) */
export function loadEngine(onProgress) {
  if (isLoaded()) return Promise.resolve(ff);
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    if (!coreURLs) coreURLs = await downloadCore((r, s) => onProgress?.(r, s, 'muat-turun'));
    onProgress?.(1, '', 'mula');
    const inst = new FFmpeg();
    inst.on('log', ({ message }) => {
      logTail.push(message);
      if (logTail.length > 400) logTail.splice(0, 200);
      logSink?.(message);
    });
    await inst.load(coreURLs);
    ff = inst;
    return ff;
  })();
  loadingPromise.finally(() => { loadingPromise = null; }).catch(() => {});
  return loadingPromise;
}

/** Hentikan worker (batal / selepas crash). Enjin dimuat semula secara automatik bila perlu. */
export function resetEngine() {
  try { ff?.terminate(); } catch { /* abaikan */ }
  ff = null;
}

let mountSeq = 0;
/** Lekap File melalui WORKERFS: fail dibaca terus dari cakera, tidak disalin ke memori wasm. */
async function mountFile(file) {
  const dir = `/in${++mountSeq}`;
  await ff.createDir(dir);
  const ok = await ff.mount('WORKERFS', { files: [file] }, dir);
  if (ok === false) throw new Error('WORKERFS tidak disokong');
  return { dir, path: `${dir}/${file.name}` };
}
async function unmountFile(m) {
  try { await ff.unmount(m.dir); } catch { /* abaikan */ }
  try { await ff.deleteDir(m.dir); } catch { /* abaikan */ }
}

async function probePath(path) {
  const out = `/probe_${Date.now()}.json`;
  await ff.ffprobe(['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path, '-o', out]);
  let txt;
  try { txt = await ff.readFile(out, 'utf8'); } catch { throw new Error('ffprobe tidak dapat membaca fail ini'); }
  try { await ff.deleteFile(out); } catch { /* abaikan */ }
  return JSON.parse(typeof txt === 'string' ? txt : new TextDecoder().decode(txt));
}

/** ffprobe pada File pengguna. */
export async function probeFile(file) {
  await loadEngine();
  const m = await mountFile(file);
  try { return await probePath(m.path); } finally { await unmountFile(m); }
}

/**
 * Jalankan satu atau lebih kerja encode pada satu fail input.
 * buildArgs(inPath, outPath) -> array argumen ffmpeg.
 * Pulangkan { data: Uint8Array, probe }.
 */
export async function encode(file, buildArgs, { onLog } = {}) {
  await loadEngine();
  const m = await mountFile(file);
  const out = `/out_${Date.now()}.mp4`;
  logSink = onLog || null;
  const startIdx = logTail.length;
  try {
    let ret;
    try {
      ret = await ff.exec(buildArgs(m.path, out));
    } catch (e) {
      // Worker crash (cth. kehabisan memori) atau dibatalkan.
      const msg = String(e?.message || e);
      resetEngine();
      const err = new Error(/terminat/i.test(msg) ? 'Dibatalkan' : 'Enjin terhenti: ' + msg);
      err.crash = !/terminat/i.test(msg);
      err.cancelled = /terminat/i.test(msg);
      throw err;
    }
    if (ret !== 0) {
      const tail = logTail.slice(startIdx).slice(-12).join('\n');
      const oom = /memory|Cannot allocate|OOM/i.test(tail);
      const err = new Error((oom ? 'Kehabisan memori. ' : '') + `ffmpeg gagal (kod ${ret}).\n` + tail);
      err.oom = oom;
      throw err;
    }
    const probe = await probePath(out);
    const data = await ff.readFile(out);
    return { data, probe };
  } finally {
    logSink = null;
    if (ff) {
      try { await ff.deleteFile(out); } catch { /* abaikan */ }
      await unmountFile(m);
    }
  }
}

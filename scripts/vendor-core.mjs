// Salin @ffmpeg/core (ESM, single-thread) ke public/vendor supaya enjin di-host sendiri
// (tidak bergantung pada unpkg). Jalankan selepas `npm install`.
import { cpSync, mkdirSync } from 'node:fs';
const v = '0.12.10';
const dst = new URL(`../public/vendor/core-${v}/`, import.meta.url);
mkdirSync(dst, { recursive: true });
for (const f of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  cpSync(new URL(`../node_modules/@ffmpeg/core/dist/esm/${f}`, import.meta.url), new URL(f, dst));
}
console.log('Core disalin ke', dst.pathname);

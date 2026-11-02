// Logik media: profil encode, bacaan ffprobe, argumen ffmpeg, pemprosesan gambar.

export const MAX_W = 1080; // potret 1080x1920 (landskap: 1920x1080)
export const MAX_H = 1920;
export const SEGMENT_SECONDS = 30;

// Titik mula untuk diuji, bukan angka muktamad.
// maxrate60 digunakan bila fps output > 31. (Ringan 60fps tidak dinyatakan dalam
// spesifikasi; 4M dipilih sebagai titik mula.)
export const PROFILES = {
  ringan:   { id: 'ringan',   label: 'Ringan',   crf: 26, maxrate: 2.5, maxrate60: 4,  jpeg: 0.85, desc: 'Fail kecil, cepat dihantar. CRF 26, maks 2.5 Mbps.' },
  seimbang: { id: 'seimbang', label: 'Seimbang', crf: 23, maxrate: 4,   maxrate60: 6,  jpeg: 0.90, desc: 'Pilihan lalai. CRF 23, maks 4 Mbps (60fps: 6 Mbps).' },
  tajam:    { id: 'tajam',    label: 'Tajam',    crf: 20, maxrate: 8,   maxrate60: 10, jpeg: 0.95, desc: 'Paling tajam, fail paling besar. CRF 20, maks 8 Mbps (60fps: 10 Mbps).' },
};

export const FPS_LABEL = { asal: 'Asal', 30: '30fps', 60: '60fps' };

export function parseRate(r) {
  if (!r || r === '0/0') return 0;
  const [a, b] = String(r).split('/').map(Number);
  const v = b ? a / b : a;
  return Number.isFinite(v) ? v : 0;
}

/** Ringkaskan output ffprobe. */
export function summarizeProbe(p) {
  const streams = p?.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = streams.find((s) => s.codec_type === 'audio');
  const fmt = p?.format || {};
  if (!v) return { hasVideo: false, hasAudio: !!a };
  const avg = parseRate(v.avg_frame_rate);
  const rr = parseRate(v.r_frame_rate);
  let duration = parseFloat(v.duration) || parseFloat(fmt.duration) || 0;
  let fps = avg > 0 && avg <= 300 ? avg : rr > 0 && rr <= 300 ? rr : 0;
  const nb = parseInt(v.nb_frames, 10);
  if (!fps && nb && duration) fps = nb / duration;
  let rotation = 0;
  for (const sd of v.side_data_list || []) if (sd.rotation != null) rotation = Number(sd.rotation);
  if (!rotation && v.tags?.rotate) rotation = Number(v.tags.rotate);
  const swap = Math.abs(rotation) % 180 === 90;
  const width = swap ? v.height : v.width;
  const height = swap ? v.width : v.height;
  const size = parseInt(fmt.size, 10) || 0;
  const bitrate = parseInt(fmt.bit_rate, 10) || (size && duration ? (size * 8) / duration : 0);
  const trc = v.color_transfer || '';
  const hdr = /smpte2084|arib-std-b67/.test(trc) || /10le|10be|p010/.test(v.pix_fmt || '');
  return {
    hasVideo: true, hasAudio: !!a, codec: v.codec_name, pixFmt: v.pix_fmt,
    width, height, fps, duration, bitrate, rotation, hdr,
  };
}

/** Sasaran fps sebenar. Tidak sekali-kali menaikkan fps sumber. */
export function resolveFps(requested, srcFps) {
  const src = srcFps || 30;
  const notes = [];
  let filter = null; // nilai untuk penapis fps, null = kekal
  let out = src;
  if (requested === '60') {
    if (src < 49) {
      notes.push(`Sumber ${fmtFps(src)}fps: 60fps tidak dibenarkan (hanya menggandakan frame). Diproses pada ${fmtFps(Math.min(src, 30))}fps.`);
      if (src > 31) { filter = 30; out = 30; }
    } else if (src > 61) { filter = 60; out = 60; }
  } else if (requested === '30') {
    if (src > 31) { filter = 30; out = 30; }
    else if (src < 29) notes.push(`Sumber ${fmtFps(src)}fps dikekalkan (tidak dinaikkan ke 30).`);
  } else { // asal
    if (src > 61) { filter = 60; out = 60; notes.push(`Sumber ${fmtFps(src)}fps (slow-mo) dihadkan ke 60fps.`); }
  }
  return { filter, out, high: out > 31, notes };
}

export function fmtFps(f) {
  if (!f) return '?';
  const r = Math.round(f * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2);
}

/** Argumen ffmpeg untuk satu output H.264/AAC. */
export function buildVideoArgs({ inPath, outPath, profile, fps, preset, start, length, hasAudio }) {
  const p = PROFILES[profile];
  const mr = fps.high ? p.maxrate60 : p.maxrate;
  const filters = [];
  if (fps.filter) filters.push(`fps=${fps.filter}`);
  // Muat dalam 1080x1920 (potret) atau 1920x1080 (landskap), tanpa membesarkan.
  filters.push(
    `scale=w='if(gt(iw,ih),min(${MAX_H},iw),min(${MAX_W},iw))':h='if(gt(iw,ih),min(${MAX_W},ih),min(${MAX_H},ih))'` +
    ':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos:out_color_matrix=bt709:out_range=tv',
    'setsar=1', 'format=yuv420p',
  );
  const gop = Math.max(1, Math.round((fps.out || 30) * 2));
  const a = ['-hide_banner', '-stats'];
  if (start) a.push('-ss', start.toFixed(3));
  a.push('-i', inPath);
  if (length) a.push('-t', length.toFixed(3));
  a.push(
    '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_metadata', '-1',
    '-vf', filters.join(','),
    '-c:v', 'libx264', '-preset', preset, '-crf', String(p.crf),
    '-maxrate', `${mr}M`, '-bufsize', `${mr * 2}M`,
    '-profile:v', 'high', '-level:v', fps.high ? '4.2' : '4.0',
    '-pix_fmt', 'yuv420p', '-g', String(gop),
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
  );
  if (hasAudio) a.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2');
  a.push('-movflags', '+faststart', '-y', outPath);
  return a;
}

/** Bahagikan tempoh kepada segmen 30 saat. */
export function segmentPlan(duration, seg = SEGMENT_SECONDS) {
  const n = Math.max(1, Math.ceil(duration / seg - 1e-3));
  const out = [];
  for (let i = 0; i < n; i++) {
    const start = i * seg;
    out.push({ index: i + 1, count: n, start, length: Math.min(seg, duration - start) });
  }
  return out;
}

// ---------------- Gambar ----------------

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Format gambar tidak disokong oleh browser ini')); };
    img.src = url;
  });
}

function fitBox(w, h) {
  const landscape = w > h;
  const bw = landscape ? MAX_H : MAX_W;
  const bh = landscape ? MAX_W : MAX_H;
  const s = Math.min(1, bw / w, bh / h);
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return { c, ctx };
}

/** Skala gambar ke maks 1080x1920 guna canvas (orientasi EXIF dihormati oleh browser), simpan JPEG. */
export async function processImage(file, quality) {
  const { img, url } = await loadImage(file);
  try {
    const sw = img.naturalWidth, sh = img.naturalHeight;
    const t = fitBox(sw, sh);
    // Kecilkan berperingkat (separuh setiap langkah) untuk hasil lebih tajam,
    // dengan had saiz kanvas perantaraan (iOS hadkan ~16 MP setiap kanvas).
    let src = img, cw = sw, ch = sh;
    const MAX_AREA = 12e6;
    while (cw / 2 >= t.w * 1.5 || cw * ch > MAX_AREA) {
      let nw = Math.max(t.w, Math.floor(cw / 2)), nh = Math.max(t.h, Math.floor(ch / 2));
      if (nw * nh > MAX_AREA) { const k = Math.sqrt(MAX_AREA / (nw * nh)); nw = Math.floor(nw * k); nh = Math.floor(nh * k); }
      const { c, ctx } = makeCanvas(nw, nh);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, nw, nh);
      ctx.drawImage(src, 0, 0, nw, nh);
      if (src !== img) { src.width = 0; src.height = 0; }
      src = c; cw = nw; ch = nh;
    }
    const { c, ctx } = makeCanvas(t.w, t.h);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, t.w, t.h);
    ctx.drawImage(src, 0, 0, t.w, t.h);
    if (src !== img) { src.width = 0; src.height = 0; }
    const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Gagal menjana JPEG'))), 'image/jpeg', quality));
    c.width = 0; c.height = 0;
    return { blob, width: t.w, height: t.h, srcWidth: sw, srcHeight: sh };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------- Format ----------------

export function fmtBytes(n) {
  if (!n && n !== 0) return '?';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
}
export function fmtDur(s) {
  if (!Number.isFinite(s)) return '?';
  const m = Math.floor(s / 60), r = Math.round(s - m * 60);
  return m ? `${m}m ${String(r).padStart(2, '0')}s` : `${(Math.round(s * 10) / 10)}s`;
}
export function fmtBitrate(bps) {
  if (!bps) return '?';
  return bps >= 1e6 ? (bps / 1e6).toFixed(2) + ' Mbps' : Math.round(bps / 1e3) + ' kbps';
}
export function baseName(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/_+/g, '_').slice(0, 40) || 'fail';
}

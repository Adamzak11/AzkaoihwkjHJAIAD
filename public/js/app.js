import * as engine from './engine.js';
import {
  PROFILES, SEGMENT_SECONDS, summarizeProbe, resolveFps, buildVideoArgs, segmentPlan,
  processImage, fmtBytes, fmtDur, fmtBitrate, fmtFps, baseName,
} from './media.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Peranti ----------
const ua = navigator.userAgent;
const isIOS = /iP(hone|ad|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const devMem = navigator.deviceMemory; // tiada di Safari
const cores = navigator.hardwareConcurrency || 0;
// "Lemah" = memori terhad untuk wasm: semua iOS Safari (had memori tab ketat),
// atau peranti dengan RAM <= 4 GB / <= 4 teras.
const weakDevice = isIOS || (devMem && devMem <= 4) || (cores && cores <= 4);

const state = {
  items: [],   // { id, file, kind, status, info, warnings, error }
  results: [], // { id, name, blob, url, kind, label, group, meta }
  busy: false,
  cancelled: false,
  shareHintShown: false,
};
let seq = 0;

// ---------- Init ----------
function init() {
  $('#verInfo').textContent = `${engine.FFMPEG_VERSION} / core ${engine.CORE_VERSION}`;
  $('#deviceInfo').textContent =
    `Peranti: ${isIOS ? 'iOS' : 'bukan iOS'}, RAM ${devMem ? devMem + ' GB' : 'tidak diketahui'}, ${cores || '?'} teras` +
    (weakDevice ? ' — mod memori terhad: video 60fps diproses 30 saat setiap kali.' : '.');

  const missing = [];
  if (typeof WebAssembly !== 'object') missing.push('WebAssembly');
  if (typeof Worker !== 'function') missing.push('Web Worker');
  if (!window.Blob || !URL.createObjectURL) missing.push('Blob URL');
  if (missing.length) {
    const c = $('#compat');
    c.hidden = false;
    c.textContent = `Browser ini tidak menyokong: ${missing.join(', ')}. Gunakan Safari (iOS 15+) atau Chrome terkini.`;
  }

  $('#fileInput').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
  $$('input[name=profile]').forEach((r) => r.addEventListener('change', updateSettingsUI));
  $$('input[name=fps]').forEach((r) => r.addEventListener('change', updateSettingsUI));
  $('#segmentChk').addEventListener('change', updateSettingsUI);
  $('#abToggle').addEventListener('change', updateSettingsUI);
  $('#abFile').addEventListener('change', updateSettingsUI);
  $$('input[name=abProfile],input[name=abFps]').forEach((r) => r.addEventListener('change', updateSettingsUI));
  $('#abLength').addEventListener('change', updateSettingsUI);
  $('#processBtn').addEventListener('click', startProcessing);
  $('#cancelBtn').addEventListener('click', cancelProcessing);
  $('#clearBtn').addEventListener('click', clearResults);
  $('#fileList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b || state.busy) return;
    state.items = state.items.filter((i) => i.id !== Number(b.dataset.remove));
    renderFiles(); updateSettingsUI();
  });
  updateSettingsUI();
}

// ---------- Fail ----------
function addFiles(files) {
  for (const file of files) {
    const kind = file.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|gif|avif)$/i.test(file.name) ? 'image'
      : file.type.startsWith('video/') || /\.(mp4|mov|m4v|3gp|webm|mkv|avi)$/i.test(file.name) ? 'video' : null;
    if (!kind) { message(`"${file.name}" bukan video atau gambar.`, 'warn'); continue; }
    const item = { id: ++seq, file, kind, status: kind === 'video' ? 'menunggu' : 'sedia', info: null, warnings: [] };
    sizeWarnings(item);
    state.items.push(item);
  }
  renderFiles();
  updateSettingsUI();
  probePending();
}

function sizeWarnings(item) {
  const mb = item.file.size / 1024 / 1024;
  if (item.kind !== 'video') {
    if (mb > 40) item.warnings.push(`Gambar sangat besar (${fmtBytes(item.file.size)}); mungkin lambat.`);
    return;
  }
  if (isIOS && mb > 300) item.warnings.push(`Fail besar (${fmtBytes(item.file.size)}). Safari iPhone mungkin kehabisan memori — gunakan pilihan potong 30 saat atau pilih 30fps.`);
  else if (!isIOS && mb > 1024) item.warnings.push(`Fail sangat besar (${fmtBytes(item.file.size)}). Proses akan lama dan mungkin kehabisan memori.`);
  else if (weakDevice && mb > 150) item.warnings.push(`Fail agak besar untuk peranti ini (${fmtBytes(item.file.size)}). Jika gagal, potong ke 30 saat atau pilih 30fps.`);
}

let probing = false;
async function probePending() {
  if (probing) return;
  probing = true;
  try {
    for (;;) {
      const item = state.items.find((i) => i.kind === 'video' && i.status === 'menunggu');
      if (!item) break;
      item.status = 'membaca';
      renderFiles();
      try {
        await ensureEngine();
        const info = summarizeProbe(await engine.probeFile(item.file));
        if (!info.hasVideo) throw new Error('Tiada trek video dijumpai');
        item.info = info;
        item.status = 'sedia';
        if (Math.max(info.width, info.height) > 4096) item.warnings.push('Resolusi melebihi 4K: proses akan sangat perlahan.');
        else if (Math.max(info.width, info.height) > 1920) item.warnings.push('Video 4K: nyahkod dalam browser berat, proses lebih perlahan.');
        if (info.hdr) item.warnings.push('Video HDR/10-bit: warna mungkin nampak pudar selepas ditukar ke SDR. iPhone: Settings › Camera › Record Video › matikan "HDR Video" untuk rakaman akan datang.');
        if (info.duration > 180) item.warnings.push(`Video panjang (${fmtDur(info.duration)}): proses akan mengambil masa yang lama.`);
      } catch (e) {
        item.status = 'ralat';
        item.error = e.message || String(e);
      }
      renderFiles();
      updateSettingsUI();
    }
  } finally { probing = false; }
}

async function ensureEngine() {
  if (engine.isLoaded()) return;
  const box = $('#engineBox');
  box.hidden = false;
  $('#engineLabel').textContent = 'Memuat enjin video…';
  try {
    await engine.loadEngine((r, src, phase) => {
      const pct = Math.round(r * 100);
      $('#engineBar').style.width = pct + '%';
      $('#enginePct').textContent = pct + '%';
      $('#engineLabel').textContent = phase === 'mula' ? 'Memulakan enjin…' : `Memuat turun enjin video (≈32 MB)${src ? ' dari ' + src : ''}…`;
    });
    box.hidden = true;
  } catch (e) {
    $('#engineLabel').textContent = e.message;
    $('#enginePct').textContent = '✕';
    throw e;
  }
}

function renderFiles() {
  const ul = $('#fileList');
  ul.innerHTML = state.items.map((it) => {
    const i = it.info;
    let meta = `${it.kind === 'video' ? '🎬' : '🖼️'} ${fmtBytes(it.file.size)}`;
    if (i) meta += ` · ${i.width}×${i.height} · ${fmtFps(i.fps)}fps · ${fmtDur(i.duration)} · ${i.codec}${i.fps >= 49 ? ' · <b class="tag">60fps OK</b>' : ''}`;
    const status = it.status === 'membaca' ? '<span class="muted">Membaca maklumat (ffprobe)…</span>'
      : it.status === 'menunggu' ? '<span class="muted">Menunggu enjin…</span>'
        : it.status === 'ralat' ? `<span class="err">Ralat: ${esc(it.error)}</span>` : '';
    return `<li>
      <div class="fl-main"><div class="fl-name">${esc(it.file.name)}</div>
      <div class="fl-meta">${meta}</div>${status ? `<div class="small">${status}</div>` : ''}
      ${it.warnings.map((w) => `<div class="small warn-text">⚠️ ${esc(w)}</div>`).join('')}</div>
      <button class="icon-btn" data-remove="${it.id}" aria-label="Buang">✕</button></li>`;
  }).join('');
}

// ---------- Tetapan ----------
const val = (name) => ($(`input[name=${name}]:checked`) || {}).value;
const vals = (name) => $$(`input[name=${name}]:checked`).map((x) => x.value);
const readyVideos = () => state.items.filter((i) => i.kind === 'video' && i.status === 'sedia');

function updateSettingsUI() {
  const profile = val('profile');
  $('#profileDesc').textContent = PROFILES[profile].desc;

  const vids = readyVideos();
  const any60 = vids.some((v) => v.info.fps >= 49);
  const r60 = $('input[name=fps][value="60"]');
  r60.disabled = !any60;
  r60.closest('label').classList.toggle('disabled', !any60);
  if (!any60 && r60.checked) $('input[name=fps][value="30"]').checked = true;
  const fps = val('fps');
  const w = $('#fps60Warn');
  if (fps === '60' || (fps === 'asal' && any60)) {
    w.hidden = false;
    w.textContent = '60fps: dua kali ganda frame berbanding 30fps — masa proses ≈2× lebih lama dan lebih banyak memori. ' +
      (weakDevice ? 'Peranti ini dikesan memori terhad, jadi video 60fps lebih 30 saat akan diproses dan dipotong 30 saat setiap kali. ' : '') +
      'Jika gagal, turun ke 30fps.' + (vids.some((v) => v.info.fps < 49) ? ' Video yang bukan 60fps akan kekal pada fps asalnya (maks 30).' : '');
  } else w.hidden = true;

  // A/B
  const ab = $('#abToggle').checked;
  $('#abPanel').hidden = !ab;
  const sel = $('#abFile');
  const prev = sel.value;
  sel.innerHTML = vids.map((v) => `<option value="${v.id}">${esc(v.file.name)} (${fmtFps(v.info.fps)}fps)</option>`).join('') || '<option value="">— pilih video dahulu —</option>';
  if (vids.some((v) => String(v.id) === prev)) sel.value = prev;
  const abItem = vids.find((v) => String(v.id) === sel.value);
  const ab60 = $('#abFps60');
  ab60.disabled = !(abItem && abItem.info.fps >= 49);
  ab60.closest('label').classList.toggle('disabled', ab60.disabled);
  if (ab60.disabled) ab60.checked = false;
  if (ab) {
    const variants = abItem ? abVariants(abItem) : [];
    $('#abSummary').innerHTML = abItem
      ? `${variants.length} versi akan dihasilkan: ${variants.map((v) => `<b>${v.letter}</b> ${v.profile.label} ${fmtFps(v.fps.out)}fps`).join(', ')}.` +
        (ab60.disabled ? ' (60fps tidak tersedia: sumber bukan 60fps.)' : '')
      : 'Pilih sekurang-kurangnya satu video.';
  }

  const canRun = !state.busy && (ab ? !!abItem && abVariants(abItem).length > 0
    : state.items.some((i) => i.status === 'sedia'));
  $('#processBtn').disabled = !canRun;
  $('#processBtn').textContent = ab ? 'Jana versi A/B' : 'Proses';
}

function abVariants(item) {
  const out = [];
  const seen = new Set();
  for (const p of vals('abProfile')) for (const f of vals('abFps')) {
    const fps = resolveFps(f, item.info.fps);
    if (f === '60' && item.info.fps < 49) continue;
    const key = `${p}|${fps.filter}|${fps.out}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ profile: PROFILES[p], fps, req: f });
  }
  out.forEach((v, i) => { v.letter = String.fromCharCode(65 + i); });
  return out;
}

// ---------- Bina senarai kerja ----------
function buildJobs() {
  const preset = $('#presetSel').value;
  const jobs = [];
  const notes = [];
  if ($('#abToggle').checked) {
    const item = readyVideos().find((v) => String(v.id) === $('#abFile').value);
    const lim = Number($('#abLength').value);
    const dur = lim && lim < item.info.duration ? lim : item.info.duration;
    for (const v of abVariants(item)) {
      const name = `AB-${v.letter}_${v.profile.label}_${Math.round(v.fps.out)}fps_${baseName(item.file.name)}`;
      const label = `${v.letter}: ${v.profile.label} ${fmtFps(v.fps.out)}fps`;
      pushVideoJobs(jobs, item, v.profile.id, v.fps, preset, dur, name, label, { ab: true, forceSplit: false });
    }
    return { jobs, notes };
  }
  const profile = val('profile');
  const fpsReq = val('fps');
  const split = $('#segmentChk').checked;
  for (const item of state.items) {
    if (item.status !== 'sedia') continue;
    if (item.kind === 'image') {
      jobs.push({ type: 'image', item, profile, name: `${baseName(item.file.name)}_status.jpg`, label: `${item.file.name} (${PROFILES[profile].label})`, weight: 1 });
      continue;
    }
    const fps = resolveFps(fpsReq, item.info.fps);
    fps.notes.forEach((n) => notes.push(`${item.file.name}: ${n}`));
    const name = `${baseName(item.file.name)}_${PROFILES[profile].label}_${Math.round(fps.out)}fps`;
    pushVideoJobs(jobs, item, profile, fps, preset, item.info.duration, name, `${item.file.name} — ${PROFILES[profile].label} ${fmtFps(fps.out)}fps`, { ab: false, forceSplit: split });
  }
  return { jobs, notes };
}

function pushVideoJobs(jobs, item, profile, fps, preset, dur, name, label, { ab, forceSplit }) {
  const autoSplit = weakDevice && fps.high && dur > SEGMENT_SECONDS + 0.5;
  const split = (forceSplit || autoSplit) && dur > SEGMENT_SECONDS + 0.5;
  const groupId = ++seq;
  if (!split) {
    jobs.push({ type: 'video', item, profile, fps, preset, start: 0, length: dur < item.info.duration - 0.05 ? dur : 0, dur,
      name: name + '.mp4', label, group: groupId, ab, autoSplit: false, weight: dur * fps.out });
    return;
  }
  for (const s of segmentPlan(dur)) {
    const part = `bahagian-${String(s.index).padStart(2, '0')}-dari-${String(s.count).padStart(2, '0')}`;
    jobs.push({ type: 'video', item, profile, fps, preset, start: s.start, length: s.length, dur: s.length,
      name: `${name}_${part}.mp4`, label: `${label} · bahagian ${s.index}/${s.count}`, group: groupId, ab, autoSplit: autoSplit && !forceSplit,
      part: s, weight: s.length * fps.out });
  }
}

// ---------- Dialog ----------
function confirmDialog(title, html) {
  const dlg = $('#confirmDlg');
  if (!dlg || typeof dlg.showModal !== 'function') {
    const tmp = document.createElement('div'); tmp.innerHTML = html;
    return Promise.resolve(window.confirm(title + '\n\n' + tmp.textContent));
  }
  $('#dlgTitle').textContent = title;
  $('#dlgBody').innerHTML = html;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((res) => dlg.addEventListener('close', () => res(dlg.returnValue === 'ok'), { once: true }));
}

// ---------- Proses ----------
let wakeLock = null;
async function startProcessing() {
  if (state.busy) return;
  const { jobs, notes } = buildJobs();
  if (!jobs.length) return;

  // Amaran sebelum 60fps / fail besar
  const hi = jobs.filter((j) => j.type === 'video' && j.fps.high);
  const warnHtml = [];
  if (hi.length) {
    const secs = hi.reduce((a, j) => a + j.dur, 0);
    const frames = Math.round(hi.reduce((a, j) => a + j.dur * j.fps.out, 0));
    warnHtml.push(`<p><b>60fps</b>: ${fmtDur(secs)} video ≈ <b>${frames.toLocaleString('ms-MY')} frame</b> perlu diencode — kira-kira <b>2× lebih lama</b> daripada 30fps, dan guna lebih banyak memori.</p>`);
    warnHtml.push(`<p>Anggaran kasar: ${weakDevice ? '3–8' : '6–20'} frame/saat di peranti ini, iaitu <b>${fmtDur(frames / (weakDevice ? 8 : 20))} – ${fmtDur(frames / (weakDevice ? 3 : 6))}</b>.</p>`);
    if (hi.some((j) => j.autoSplit)) warnHtml.push(`<p>Peranti ini mempunyai memori terhad, jadi video 60fps diproses <b>${SEGMENT_SECONDS} saat setiap kali</b> dan disimpan sebagai bahagian bernombor.</p>`);
    warnHtml.push('<p>Jika gagal, cuba semula pada 30fps.</p>');
  }
  const big = state.items.filter((i) => i.warnings.some((w) => /memori/.test(w)) && jobs.some((j) => j.item === i));
  if (big.length) warnHtml.push(`<p>⚠️ ${big.map((b) => esc(b.file.name)).join(', ')}: fail besar untuk memori peranti ini.</p>`);
  if (warnHtml.length) {
    warnHtml.push('<p class="small">Biarkan skrin terbuka dan jangan tukar app semasa proses.</p>');
    if (!(await confirmDialog('Sebelum mula', warnHtml.join('')))) return;
  }
  notes.forEach((n) => message(n, 'info'));
  await runJobs(jobs);
}

async function runJobs(jobs) {
  state.busy = true;
  state.cancelled = false;
  updateSettingsUI();
  $('#progressBox').hidden = false;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* tidak disokong */ }

  const totalWeight = jobs.reduce((a, j) => a + j.weight, 0) || 1;
  let doneWeight = 0;
  const t0 = performance.now();
  let failed = 0;

  for (let idx = 0; idx < jobs.length; idx++) {
    if (state.cancelled) break;
    const job = jobs[idx];
    $('#jobLabel').textContent = job.label;
    $('#overallLabel').textContent = `Kerja ${idx + 1} daripada ${jobs.length}`;
    setJobProgress(0);
    const js = performance.now();
    try {
      if (job.type === 'image') {
        const r = await processImage(job.item.file, PROFILES[job.profile].jpeg);
        addResult({
          name: job.name, blob: r.blob, kind: 'image', label: job.label, group: null,
          meta: { size: r.blob.size, width: r.width, height: r.height, src: `${r.srcWidth}×${r.srcHeight}` },
        });
      } else {
        await ensureEngine();
        const jobFrames = job.dur;
        const res = await engine.encode(job.item.file, (inPath, outPath) => buildVideoArgs({
          inPath, outPath, profile: job.profile, fps: job.fps, preset: job.preset,
          start: job.start, length: job.length, hasAudio: job.item.info.hasAudio,
        }), {
          onLog: (line) => {
            const m = /time=\s*(-?\d+):(\d+):([\d.]+)/.exec(line);
            if (!m) return;
            const t = Math.max(0, +m[1] * 3600 + +m[2] * 60 + +m[3]);
            const frac = Math.min(1, t / (jobFrames || 1));
            setJobProgress(frac);
            const fpsM = /fps=\s*([\d.]+)/.exec(line);
            const elapsed = (performance.now() - t0) / 1000;
            const doneNow = doneWeight + frac * job.weight;
            const eta = doneNow > 0 ? elapsed * (totalWeight - doneNow) / doneNow : 0;
            $('#etaLabel').textContent = `${fpsM ? fpsM[1] + ' fps encode · ' : ''}baki ≈ ${fmtDur(eta)}`;
          },
        });
        const info = summarizeProbe(res.probe);
        const blob = new Blob([res.data], { type: 'video/mp4' });
        addResult({
          name: job.name, blob, kind: 'video', label: job.label, group: job.group, ab: job.ab,
          meta: {
            size: blob.size, width: info.width, height: info.height, fps: info.fps, duration: info.duration,
            bitrate: info.duration ? blob.size * 8 / info.duration : info.bitrate, codec: info.codec,
            secs: (performance.now() - js) / 1000, requestedFps: job.fps.out,
          },
          part: job.part,
        });
      }
    } catch (e) {
      if (state.cancelled || e.cancelled) break;
      failed++;
      reportFailure(job, e);
    }
    doneWeight += job.weight;
    setJobProgress(1);
  }

  try { await wakeLock?.release(); } catch { /* abaikan */ }
  wakeLock = null;
  state.busy = false;
  $('#progressBox').hidden = true;
  if (state.cancelled) message('Proses dibatalkan.', 'info');
  else if (!failed) message(`Siap: ${jobs.length} fail diproses dalam ${fmtDur((performance.now() - t0) / 1000)}.`, 'ok');
  updateSettingsUI();
}

function setJobProgress(frac) {
  const pct = Math.round(frac * 100);
  $('#jobBar').style.width = pct + '%';
  $('#jobPct').textContent = pct + '%';
}

function cancelProcessing() {
  state.cancelled = true;
  engine.resetEngine();
}

function reportFailure(job, e) {
  const box = message('', 'err');
  const tips = [];
  if (job.type === 'video' && job.fps.high) tips.push('Cadangan: turun ke 30fps.');
  if (job.type === 'video' && !job.part && job.dur > SEGMENT_SECONDS) tips.push('Atau aktifkan "Potong video lebih 30 saat".');
  if (e.crash || e.oom) tips.unshift('Kemungkinan memori peranti tidak mencukupi.');
  box.innerHTML = `<b>Gagal:</b> ${esc(job.label)}<br>${esc(String(e.message || e).split('\n')[0])}<br>${tips.join(' ')}` +
    '<details><summary>Log</summary><pre></pre></details>';
  box.querySelector('pre').textContent = String(e.message || e) + '\n---\n' + engine.lastLogs(20);
  if (job.type === 'video' && job.fps.high) {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = 'Cuba semula pada 30fps';
    b.onclick = async () => {
      if (state.busy) return;
      b.disabled = true;
      const fps = resolveFps('30', job.item.info.fps);
      await runJobs([{
        ...job, fps, autoSplit: false, weight: job.dur * fps.out,
        name: job.name.replace(/_\d+fps/, `_${Math.round(fps.out)}fps`),
        label: job.label.replace(/\d+(\.\d+)?fps/, `${fmtFps(fps.out)}fps`),
      }]);
    };
    box.appendChild(b);
  }
}

function message(text, kind = 'info') {
  const div = document.createElement('div');
  div.className = 'msg ' + kind;
  div.textContent = text;
  const close = document.createElement('button');
  close.className = 'icon-btn msg-x';
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Tutup');
  close.onclick = () => div.remove();
  div.appendChild(close);
  $('#messages').prepend(div);
  return div;
}

// ---------- Hasil ----------
function addResult(r) {
  r.id = ++seq;
  r.url = URL.createObjectURL(r.blob);
  r.file = new File([r.blob], r.name, { type: r.blob.type });
  state.results.push(r);
  renderResults();
}

function clearResults() {
  state.results.forEach((r) => URL.revokeObjectURL(r.url));
  state.results = [];
  renderResults();
}

function renderResults() {
  $('#resultsCard').hidden = !state.results.length;
  const wrap = $('#results');
  wrap.innerHTML = '';
  // Kumpulan bahagian dengan butang "Kongsi semua"
  const groups = new Map();
  for (const r of state.results) {
    const key = r.group && r.part ? 'g' + r.group : 'r' + r.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const list of groups.values()) {
    if (list.length > 1 || list[0].part) {
      const g = document.createElement('div');
      g.className = 'group';
      const head = document.createElement('div');
      head.className = 'row between group-head';
      const total = list[0].part ? list[0].part.count : list.length;
      head.innerHTML = `<strong>${esc(list[0].label.replace(/ · bahagian.*$/, ''))}</strong><span class="small muted">${list.length}/${total} bahagian · post ikut turutan</span>`;
      const all = document.createElement('button');
      all.className = 'btn small';
      all.textContent = `Kongsi semua (${list.length})`;
      all.onclick = () => shareFiles(list.map((r) => r.file), list);
      head.appendChild(all);
      g.appendChild(head);
      list.forEach((r) => g.appendChild(resultCard(r)));
      wrap.appendChild(g);
    } else wrap.appendChild(resultCard(list[0]));
  }
  // Jadual A/B
  const ab = state.results.filter((r) => r.ab);
  $('#abTableWrap').hidden = !ab.length;
  $('#abTable tbody').innerHTML = ab.map((r) => `<tr><td>${esc(r.label)}</td><td>${fmtBytes(r.meta.size)}</td><td>${r.meta.width}×${r.meta.height}</td><td>${fmtBitrate(r.meta.bitrate)}</td><td>${fmtFps(r.meta.fps)}</td><td>${fmtDur(r.meta.secs)}</td></tr>`).join('');
}

function resultCard(r) {
  const el = document.createElement('div');
  el.className = 'result';
  const m = r.meta;
  const fpsWarn = r.kind === 'video' && m.requestedFps && Math.abs(m.fps - m.requestedFps) > 1
    ? `<span class="warn-text"> (dijangka ${fmtFps(m.requestedFps)})</span>` : '';
  const rows = r.kind === 'video'
    ? [['Saiz', fmtBytes(m.size)], ['Resolusi', `${m.width}×${m.height}`], ['FPS sebenar', fmtFps(m.fps) + fpsWarn],
      ['Bitrate', fmtBitrate(m.bitrate)], ['Tempoh', fmtDur(m.duration)], ['Masa proses', fmtDur(m.secs)]]
    : [['Saiz', fmtBytes(m.size)], ['Resolusi', `${m.width}×${m.height}`], ['Asal', m.src], ['Format', 'JPEG']];
  el.innerHTML = `
    <div class="res-media">${r.kind === 'video'
      ? `<video src="${r.url}#t=0.1" controls playsinline muted preload="metadata"></video>`
      : `<img src="${r.url}" alt="">`}</div>
    <div class="res-body">
      <div class="res-label">${esc(r.label)}</div>
      <div class="res-name small muted">${esc(r.name)}</div>
      <dl class="meta">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
      <div class="row gap">
        <button class="btn primary small" data-act="share">Kongsi</button>
        <button class="btn small" data-act="dl">Muat turun</button>
      </div>
    </div>`;
  el.querySelector('[data-act=share]').onclick = () => shareFiles([r.file], [r]);
  el.querySelector('[data-act=dl]').onclick = () => { download(r); showShareHint(); };
  return el;
}

async function shareFiles(files, results) {
  let can = false;
  try { can = !!(navigator.canShare && navigator.canShare({ files })); } catch { can = false; }
  if (can) {
    try { await navigator.share({ files }); return; } catch (e) {
      if (e.name === 'AbortError') return;
      console.warn('share gagal', e);
    }
  }
  // Fallback: muat turun
  for (let i = 0; i < results.length; i++) {
    download(results[i]);
    if (i < results.length - 1) await new Promise((r) => setTimeout(r, 700));
  }
  showShareHint(true);
}

function download(r) {
  const a = document.createElement('a');
  a.href = r.url;
  a.download = r.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function showShareHint(fromShare) {
  if (state.shareHintShown) return;
  state.shareHintShown = true;
  message((fromShare ? 'Kongsi fail tidak disokong di browser ini, jadi fail dimuat turun. ' : '') +
    'Seterusnya: simpan ke galeri (iPhone: app Files › fail › Kongsi › Save Video) dan post dari galeri, ' +
    'ATAU hantar ke chat sendiri dalam mod HD (Settings › Storage and data › Media upload quality › HD) lalu forward ke Status.', 'info');
}

init();

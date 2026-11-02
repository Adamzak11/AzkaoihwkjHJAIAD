# Status Tajam

Webapp statik (HTML + JS, tanpa server) untuk menyediakan video dan gambar supaya lebih tajam bila dipost ke Status WhatsApp. Semua proses berlaku dalam browser dengan [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm). Tiada fail diupload ke mana-mana server.

> **Nota jujur:** Aplikasi ini tidak post terus ke Status (WhatsApp tiada API untuk itu) dan tidak menjamin kualiti. WhatsApp boleh memampat semula fail, dan servernya mungkin menurunkan fps atau bitrate. Hasil berubah ikut versi WhatsApp, jadi buat ujian A/B.

## Struktur

```
public/                 ← folder yang dideploy (Netlify "publish")
  index.html
  css/style.css
  js/app.js             UI dan aliran kerja
  js/engine.js          muat ffmpeg.wasm, ffprobe, encode (WORKERFS)
  js/media.js           profil, argumen ffmpeg, fps, segmen, gambar (canvas)
  vendor/ffmpeg-0.12.15/  @ffmpeg/ffmpeg 0.12.15 (ESM, di-host sendiri)
  _headers              header Netlify
netlify.toml
scripts/serve.mjs       pelayan tempatan
scripts/vendor-core.mjs salin core ke public/vendor (pilihan: host sendiri)
tests/                  fixture + ujian Playwright
```

Versi yang dipin: `@ffmpeg/ffmpeg@0.12.15`, `@ffmpeg/core@0.12.10` (single-thread, ESM). Core (~32 MB) dimuat dari `https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm/` hanya selepas pengguna memilih video, dengan progress bar. Fail itu disimpan dalam cache browser. jsDelivr tidak digunakan kerana ia tidak melayan fail lebih 20 MB.

## Deploy ke Netlify

**Cara A, seret & lepas:** buka https://app.netlify.com/drop dan seret folder `public/`.

**Cara B, dari Git:** push repo ini ke GitHub, kemudian di Netlify pilih *Add new site › Import an existing project*. Tetapan diambil dari `netlify.toml` (publish = `public`, tiada build).

**Cara C, CLI:**
```bash
npx netlify-cli deploy --dir=public --prod
```

**Pilihan: host core sendiri, tanpa unpkg.** Tetapkan build command di Netlify kepada `npm install && npm run vendor-core`. Skrip ini menyalin core ke `public/vendor/core-0.12.10/`, dan `engine.js` akan guna salinan tempatan itu dahulu sebelum unpkg.

Uji di komputer sendiri: `npm run serve`, kemudian buka http://localhost:8080. Untuk uji dari telefon dalam rangkaian yang sama, guna IP komputer. Perlu diingat bahawa `navigator.share` hanya berfungsi melalui HTTPS, jadi butang Kongsi yang sebenar hanya boleh diuji pada URL Netlify.

## Kenapa single-thread (tiada COOP/COEP)

Versi multithread (`@ffmpeg/core-mt`) memerlukan `SharedArrayBuffer`. Itu bermakna halaman mesti *cross-origin isolated*, dengan header `Cross-Origin-Opener-Policy: same-origin` dan `Cross-Origin-Embedder-Policy: require-corp`. Saya pilih single-thread atas sebab berikut:

1. **iOS Safari:** setiap thread ialah Worker dengan memori wasm yang dikongsi dan lebih besar. Safari iPhone menghadkan memori tab dengan ketat, jadi risiko tab "reload" atau crash bertambah. Mobile Safari ialah sasaran utama app ini.
2. **Kestabilan:** core-mt 0.12.x ada isu tergantung (hang) yang diketahui untuk sesetengah arahan. Single-thread lebih perlahan tetapi boleh dijangka.
3. **COEP `require-corp`** menyekat sumber cross-origin yang tidak menghantar CORP/CORS, dan menambah satu lagi punca kegagalan di Netlify atau CDN.
4. **Keuntungan terhad:** pada telefon, kelajuan biasanya hanya naik sekitar 1.5 hingga 2 kali, dan itu tidak berbaloi dengan risiko di atas.

Oleh itu `public/_headers` hanya mengandungi header keselamatan biasa. Jika anda mahu cuba multithread kemudian, tambah header di bawah dan tukar `engine.js` kepada `@ffmpeg/core-mt@0.12.10` (tambah juga `workerURL`):
```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

## Apa yang app ini buat

- **Video:** H.264 High, yuv420p, AAC 128k stereo, `+faststart`, skala supaya muat dalam 1080×1920 (potret) atau 1920×1080 (landskap) dengan Lanczos, tanpa dibesarkan.

  | Profil   | CRF | maxrate 30fps | maxrate 60fps |
  |----------|-----|---------------|---------------|
  | Ringan   | 26  | 2.5M          | 4M (pilihan saya, tiada dalam spesifikasi) |
  | Seimbang | 23  | 4M            | 6M            |
  | Tajam    | 20  | 8M            | 10M           |

  `bufsize` = 2× maxrate. Level 4.0 untuk ≤30fps dan 4.2 untuk 60fps. Preset lalai ialah `veryfast` dan boleh ditukar di bahagian *Lanjutan*. Angka ini titik mula untuk diuji, bukan nilai muktamad. Ubah di `public/js/media.js` (`PROFILES`).
- **FPS:** fps sumber dibaca dengan ffprobe. 60fps hanya boleh dipilih jika sumber ≥ 50fps. FPS tidak pernah dinaikkan (cth. 30 ke 60). Slow-mo 120/240 dihadkan ke 60. Selepas proses, fps hasil disemak semula dengan ffprobe dan dipaparkan sebagai "FPS sebenar".
- **60fps:** sebelum mula, app paparkan amaran masa dan memori beserta anggaran bilangan frame. Pada peranti memori terhad (semua iOS, atau RAM ≤ 4 GB, atau ≤ 4 teras), video 60fps yang lebih 30 saat diproses 30 saat setiap kali. Jika proses gagal, ada butang "Cuba semula pada 30fps".
- **Potong 30 saat:** setiap bahagian diencode sebagai fail berasingan (`-ss`/`-t` yang tepat), jadi setiap fail bermula dengan keyframe IDR. Fail dinamakan `…_bahagian-01-dari-03.mp4` dan seterusnya. Cara ini juga menjimatkan memori kerana hanya satu bahagian berada dalam memori pada satu masa.
- **Memori:** input dibaca terus dari fail melalui WORKERFS dan tidak disalin ke memori wasm. App beri amaran untuk fail besar, terutamanya di iOS (> 300 MB), video 4K dan video HDR/10-bit (warna mungkin pudar).
- **Gambar:** canvas mengecilkan gambar secara berperingkat ke maks 1080×1920 (orientasi EXIF dihormati), kemudian simpan sebagai JPEG dengan kualiti 0.85, 0.90 atau 0.95 ikut profil.
- **Kongsi:** guna `navigator.canShare({files})` dan `navigator.share`. Jika tidak disokong, fail dimuat turun dan app paparkan arahan seterusnya.

## Cara buat ujian A/B di telefon

1. Buka URL Netlify di **Safari (iPhone)** atau **Chrome (Android)**.
2. Rakam satu klip pendek yang banyak butiran dan gerakan (cth. daun, teks kecil, panning). Untuk uji 60fps, rakam dalam mod 60fps:
   - iPhone: *Settings › Camera › Record Video › 1080p at 60 fps*. Disyorkan juga matikan *HDR Video*.
   - Android: pilih 60fps dalam app kamera.
3. Dalam app: **Pilih fail**, kemudian hidupkan **Mod ujian A/B**.
4. Pilih profil (cth. Seimbang + Tajam) dan FPS (30fps + 60fps). Pilihan 60fps hanya aktif jika sumber memang 60fps. Panjang ujian lalai ialah 15 saat pertama.
5. Tekan **Jana versi A/B**. Setiap versi diberi label huruf (A, B, C…) dan nama fail seperti `AB-B_Tajam_60fps_…mp4`. Jadual perbandingan memaparkan saiz, resolusi, bitrate, FPS sebenar dan masa proses.
6. Tekan **Kongsi** pada setiap versi › WhatsApp › Status Saya. **Taip label (cth. "B: Tajam 60fps") sebagai kapsyen** supaya anda tahu versi mana yang mana.
7. Buka Status itu di **telefon lain** (bukan telefon yang menghantar, kerana telefon itu mungkin memaparkan salinan tempatan). Bandingkan ketajaman teks dan butiran, kelancaran gerakan, dan kekotakan (blocking) pada gerakan pantas.
8. Ulang selepas WhatsApp dikemas kini, kerana pemampatan di pihak WhatsApp boleh berubah.

Jika butang Kongsi tidak berfungsi, guna **Muat turun**. Kemudian simpan ke galeri, atau hantar ke chat sendiri dalam mod HD (*Settings › Storage and data › Media upload quality › HD*) dan forward ke Status.

## Ujian automatik (Playwright, Chromium)

```bash
npm install                 # @ffmpeg/core untuk mod CORE=local
npm run fixtures            # perlu ffmpeg asli: video 15s/60s pada 30/60fps, HEVC 4K, gambar
CORE=local node tests/e2e.mjs normal30 normal60 segment segment60 ab image hevc
```
Hasil disimpan dalam `tests/out/` dan disemak dengan ffprobe asli (codec, profil, level, fps, resolusi, bitrate, audio, faststart).

## Had yang diketahui

- Encode dalam wasm single-thread perlahan. Pada telefon, jangkakan beberapa minit untuk klip 60 saat (lebih lama untuk 60fps atau sumber 4K). Jangan tutup skrin semasa proses. App cuba aktifkan Wake Lock jika browser menyokongnya.
- iOS mungkin memampat video semasa dipilih melalui pemilih foto Safari. Semak resolusi yang dipaparkan dalam senarai fail. Jika lebih rendah dari asal, simpan video ke app Files dahulu dan pilih dari situ.
- Video HDR (Dolby Vision/HLG) ditukar ke SDR tanpa tone-mapping, jadi warna boleh nampak pudar.

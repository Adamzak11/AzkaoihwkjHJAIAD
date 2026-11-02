#!/usr/bin/env bash
# Jana fail ujian dengan ffmpeg asli: video 15s & 60s pada 30fps dan 60fps, dan satu gambar.
set -euo pipefail
D="$(dirname "$0")/fixtures"; mkdir -p "$D"
mk() { # nama tempoh fps saiz codec
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=size=$4:rate=$3:duration=$2" \
    -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=$2" \
    -c:v "$5" -pix_fmt yuv420p -preset ultrafast -crf 18 -c:a aac -b:a 160k -shortest "$D/$1"
}
mk v15_30.mp4 15 30 1080x1920 libx264
mk v15_60.mp4 15 60 1080x1920 libx264
mk v60_30.mp4 60 30 1080x1920 libx264
mk v60_60.mp4 60 60 1080x1920 libx264
# Video landskap HEVC 4K seperti telefon (untuk semak skala + nyahkod HEVC)
mk v5_4k_hevc.mov 5 30 3840x2160 libx265
# Gambar besar 4032x3024 (landskap) dan potret
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=4032x3024:rate=1:duration=1" -frames:v 1 -q:v 2 "$D/img_4032x3024.jpg"
ls -la "$D"

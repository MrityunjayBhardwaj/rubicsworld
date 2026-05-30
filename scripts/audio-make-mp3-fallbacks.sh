#!/usr/bin/env bash
# Generate .mp3 siblings for every .ogg asset under public/ (#74).
#
# Why: Safari ≤ 16 and iOS Web Audio can't decode Opus-in-Ogg. The bus
# falls back to the .mp3 sibling on decode failure (see bus.ts:loadBuffer),
# but only if the file actually exists at <path>.mp3.
#
# Idempotent: skips files whose .mp3 sibling is newer than the .ogg
# source. Run after adding/updating any .ogg asset (or as a pre-commit
# step if you'd rather catch them in CI).
#
# Bitrate: 160 kbps CBR. Game SFX + ambient loops don't need broadcast
# quality; this keeps file sizes ~2-3× the opus source (acceptable since
# only Safari/iOS users pay the bandwidth — everyone else loads .ogg).

set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ERROR: ffmpeg not found on PATH" >&2
  echo "  install via brew: brew install ffmpeg" >&2
  exit 1
fi

# `find -print0` + `read -d ''` to survive spaces / unicode in filenames.
converted=0
skipped=0
failed=0

while IFS= read -r -d '' ogg; do
  mp3="${ogg%.ogg}.mp3"
  if [ -f "$mp3" ] && [ "$mp3" -nt "$ogg" ]; then
    skipped=$((skipped+1))
    continue
  fi
  # -y overwrite, -loglevel error keeps the script output readable
  # -codec:a libmp3lame -b:a 160k for predictable CBR (vs default VBR
  # which has worst-case spikes that hurt iOS first-play latency)
  if ffmpeg -y -loglevel error -i "$ogg" -codec:a libmp3lame -b:a 160k "$mp3" 2>&1; then
    converted=$((converted+1))
    src_size=$(wc -c < "$ogg")
    dst_size=$(wc -c < "$mp3")
    printf "  ✓ %s  (%.1f KB → %.1f KB)\n" "$ogg" "$(echo "$src_size / 1024" | bc -l)" "$(echo "$dst_size / 1024" | bc -l)"
  else
    failed=$((failed+1))
    echo "  ✗ $ogg" >&2
  fi
done < <(find public -name '*.ogg' -type f -print0)

echo ""
echo "converted: $converted, skipped: $skipped, failed: $failed"
[ "$failed" -eq 0 ]

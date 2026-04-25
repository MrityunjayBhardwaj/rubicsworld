#!/usr/bin/env bash
# Encode audio assets from src/sfx/ raw originals → public/audio/ ogg files.
# Idempotent: re-run any time after dropping new raws into src/sfx/.
#
# Settings: mono, libopus @ 64kbps in an .ogg container (opus is superior
# to vorbis at low bitrates and decodes natively in modern browsers via
# Web Audio's decodeAudioData). -16 LUFS loudness target on event one-shots
# so they sit at a consistent perceived level. Loop sources skip loudnorm
# to preserve their natural envelope (loudnorm's compression rounds out
# loop seams).
#
# Requires: ffmpeg (brew install ffmpeg).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src/sfx"
DST="$ROOT/public/audio"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg not found — install with: brew install ffmpeg" >&2
  exit 1
fi

mkdir -p "$DST"

# Loudnorm is two-pass for the cleanest result, but a single-pass approximation
# is fast enough for our small library. Loop sources skip loudnorm to preserve
# their natural envelope (loop seams are sensitive to dynamic compression).
encode_loop() {
  local in="$1" out="$2"
  ffmpeg -y -loglevel error -i "$in" \
    -ac 1 -c:a libopus -b:a 64k \
    "$DST/$out"
  echo "  ✓ $out  ($(du -h "$DST/$out" | cut -f1))"
}

encode_event() {
  local in="$1" out="$2"
  ffmpeg -y -loglevel error -i "$in" \
    -af loudnorm=I=-16:TP=-1.5:LRA=11 \
    -ac 1 -c:a libopus -b:a 64k \
    "$DST/$out"
  echo "  ✓ $out  ($(du -h "$DST/$out" | cut -f1))"
}

echo "encoding loops..."
encode_loop "$SRC/Theme Music/FIRST_STEPS_THEME_LOOP_A.wav"          theme.ogg
encode_loop "$SRC/windy_grass.mp3"                                    windy_grass.ogg
encode_loop "$SRC/Wind.m4a"                                           wind_cutting.ogg
encode_loop "$SRC/flocks_flying.mp3"                                  birds.ogg
encode_loop "$SRC/car_moving_sound.mp3"                               car.ogg
encode_loop "$SRC/pond_and_windy_grass.mp3"                           pond.ogg
encode_loop "$SRC/rubics_world_axis_rotation/rubics_world_axis_rotation.mp3" axis_rotation.ogg
encode_loop "$SRC/grass_onhover_interaction.mp3"                      grass_swipe.ogg

echo "encoding events..."
encode_event "$SRC/walker/TomWinandySFX - FS_grass_jump_09.wav"       footstep_grass.ogg
encode_event "$SRC/walker/jump_then_land_on_grass.mp3"                jump_grass.ogg

echo
echo "total:"
du -ch "$DST"/*.ogg | tail -1

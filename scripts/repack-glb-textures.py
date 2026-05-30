#!/usr/bin/env python3
"""Resize oversized PNG/JPEG textures embedded in a binary glTF (.glb).

Why: Blender's glTF exporter embeds source textures at their authored
resolution. Asset packs from CGTrader / Sketchfab often ship 4K or 8K
"VRayCompleteMap" PNGs that are uncompressed-equivalent — a single 25 MB
texture per material × N materials = file balloons past GitHub's 100 MB
push limit. Game-side we never sample these at > 2K on the typical
display, so downsampling at pack time is free quality.

Usage:
    python3 scripts/repack-glb-textures.py INPUT.glb OUTPUT.glb \\
        [--max-edge 2048] [--dry-run]

Notes:
- Only touches images referenced by buffer views (the only way Blender
  embeds them for GLB). External-uri images are left alone.
- Preserves the original mime type. PNG stays lossless PNG; JPEG stays
  JPEG. No KTX2 / Basis — the caller can decide whether to layer that on.
- Rewrites the BIN chunk + bufferView offsets/lengths. All non-image
  bufferViews keep their byte ranges (relative to the new BIN chunk).
- Padded to 4-byte alignment per the glTF 2.0 spec.

Exit codes:
    0 = success (or dry-run)
    1 = input parsing / write failure
"""

from __future__ import annotations
import argparse
import io
import json
import os
import struct
import sys
from typing import Tuple

from PIL import Image

GLB_MAGIC = 0x46546C67     # 'glTF' little-endian
GLB_VERSION = 2
CHUNK_JSON = 0x4E4F534A    # 'JSON'
CHUNK_BIN = 0x004E4942     # 'BIN\0'


def pad4(n: int) -> int:
    return (4 - (n % 4)) % 4


def read_glb(path: str) -> Tuple[dict, bytes]:
    with open(path, 'rb') as f:
        head = f.read(12)
        magic, version, total = struct.unpack('<III', head)
        if magic != GLB_MAGIC:
            raise ValueError(f"not a glb: {path}")
        if version != GLB_VERSION:
            raise ValueError(f"glb v{version} unsupported (need v2)")
        json_hdr = f.read(8)
        json_len, json_type = struct.unpack('<II', json_hdr)
        if json_type != CHUNK_JSON:
            raise ValueError("first chunk is not JSON")
        json_bytes = f.read(json_len)
        bin_hdr = f.read(8)
        if not bin_hdr:
            return json.loads(json_bytes), b''
        bin_len, bin_type = struct.unpack('<II', bin_hdr)
        if bin_type != CHUNK_BIN:
            raise ValueError("second chunk is not BIN")
        bin_bytes = f.read(bin_len)
        return json.loads(json_bytes), bin_bytes


def write_glb(path: str, gltf: dict, bin_bytes: bytes) -> None:
    json_bytes = json.dumps(gltf, separators=(',', ':')).encode('utf-8')
    json_bytes += b' ' * pad4(len(json_bytes))
    bin_bytes_padded = bin_bytes + b'\x00' * pad4(len(bin_bytes))
    total = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes_padded)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', GLB_MAGIC, GLB_VERSION, total))
        f.write(struct.pack('<II', len(json_bytes), CHUNK_JSON))
        f.write(json_bytes)
        f.write(struct.pack('<II', len(bin_bytes_padded), CHUNK_BIN))
        f.write(bin_bytes_padded)


def downsize_image(raw: bytes, mime: str, max_edge: int) -> Tuple[bytes, bool]:
    """Return (new_bytes, was_resized). Preserves mime; returns input unchanged
    when image is already ≤ max_edge on both edges."""
    img = Image.open(io.BytesIO(raw))
    img.load()
    w, h = img.size
    if max(w, h) <= max_edge:
        return raw, False
    scale = max_edge / max(w, h)
    new_size = (max(1, int(round(w * scale))), max(1, int(round(h * scale))))
    # Lanczos for high-quality downsample. preserves alpha/RGB modes.
    img = img.resize(new_size, Image.LANCZOS)
    out = io.BytesIO()
    if mime == 'image/jpeg':
        # JPEG quality 92 — slight savings over input; visually transparent.
        if img.mode == 'RGBA':
            img = img.convert('RGB')
        img.save(out, format='JPEG', quality=92, optimize=True)
    else:
        # PNG (lossless). Keep as-is; the resize alone is the saving.
        img.save(out, format='PNG', optimize=True)
    return out.getvalue(), True


def repack(input_path: str, output_path: str, max_edge: int, dry_run: bool) -> int:
    gltf, bin_bytes = read_glb(input_path)
    buffer_views = gltf.get('bufferViews', [])
    images = gltf.get('images', [])

    print(f"input:  {input_path}  ({os.path.getsize(input_path)/1024/1024:.1f} MB)")
    print(f"images: {len(images)}  bufferViews: {len(buffer_views)}  max-edge: {max_edge}")

    # First pass — extract every bufferView's raw bytes for the FIRST buffer
    # (index 0 — the GLB embedded BIN chunk). Multi-buffer glbs are rare; we
    # only repack buffer 0.
    bv_bytes: list[bytes] = []
    for bv in buffer_views:
        if bv.get('buffer', 0) != 0:
            bv_bytes.append(None)  # leave foreign buffers alone
            continue
        off = bv.get('byteOffset', 0)
        ln = bv.get('byteLength', 0)
        bv_bytes.append(bin_bytes[off:off + ln])

    # Second pass — for each image referencing a bufferView, downsize.
    resized_count = 0
    saved_bytes = 0
    for img in images:
        bv_idx = img.get('bufferView')
        if bv_idx is None:
            continue
        original = bv_bytes[bv_idx]
        if original is None:
            continue
        mime = img.get('mimeType') or 'image/png'
        new_bytes, did_resize = downsize_image(original, mime, max_edge)
        if did_resize:
            resized_count += 1
            saved_bytes += len(original) - len(new_bytes)
            bv_bytes[bv_idx] = new_bytes
            name = img.get('name', '?')
            print(f"  resized: {name:40s}  {len(original)/1024/1024:6.2f} MB → {len(new_bytes)/1024/1024:6.2f} MB")

    print(f"resized {resized_count} image(s), saved {saved_bytes/1024/1024:.1f} MB")

    # Third pass — rebuild BIN chunk with new offsets. Walk bufferViews in their
    # original order to keep accessor references consistent. Pad each entry to
    # 4-byte alignment for glTF spec compliance.
    out = bytearray()
    new_offsets: list[int] = []
    for i, bv in enumerate(buffer_views):
        if bv_bytes[i] is None:
            # Foreign buffer — leave offset/length alone, don't append.
            new_offsets.append(bv.get('byteOffset', 0))
            continue
        offset = len(out)
        chunk = bv_bytes[i]
        out.extend(chunk)
        out.extend(b'\x00' * pad4(len(chunk)))
        new_offsets.append(offset)

    # Update JSON: bufferView offsets/lengths + buffer 0 total length.
    for i, bv in enumerate(buffer_views):
        if bv_bytes[i] is None:
            continue
        bv['byteOffset'] = new_offsets[i]
        bv['byteLength'] = len(bv_bytes[i])

    if gltf.get('buffers'):
        gltf['buffers'][0]['byteLength'] = len(out)

    if dry_run:
        print(f"dry-run: would write {len(out)/1024/1024:.1f} MB BIN")
        return 0

    write_glb(output_path, gltf, bytes(out))
    print(f"output: {output_path}  ({os.path.getsize(output_path)/1024/1024:.1f} MB)")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('input', help='source .glb')
    p.add_argument('output', help='destination .glb (overwritten if exists)')
    p.add_argument('--max-edge', type=int, default=2048, help='maximum width/height in pixels (default 2048)')
    p.add_argument('--dry-run', action='store_true', help="print savings, don't write output")
    args = p.parse_args()
    return repack(args.input, args.output, args.max_edge, args.dry_run)


if __name__ == '__main__':
    sys.exit(main())

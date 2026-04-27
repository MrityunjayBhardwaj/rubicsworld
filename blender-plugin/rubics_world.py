bl_info = {
    "name": "Rubic's World (v2)",
    "author": "Rubic's World",
    "version": (0, 2, 0),
    "blender": (4, 0, 0),
    "location": "View3D > Sidebar > Rubic's World",
    "description": (
        "Round-trip diorama.glb between Blender and the Rubic's World app. "
        "v2 adds KHR_audio_emitter export — author Speaker objects in Blender "
        "and they ship in the .glb as positional audio emitters with "
        "rubics-private modulator metadata in extras."
    ),
    "category": "Import-Export",
}

"""
Rubic's World — Blender addon

Single-file Blender plugin that wraps the diorama.glb round-trip the app
expects: correct +Y up / apply-transforms / animations-on export flags,
convention-aware pre-flight validation, and one-click reference-grid setup
so you can author on the cross cube-net without eyeballing coordinates.

Workflow once installed:
    1. Set the project path (once) → points at the RubicsWorld repo root.
    2. "Import Diorama"    → loads  <project>/public/diorama.glb
    3. (edit, add animations, keep every object inside one face block…)
    4. "Export Diorama"    → writes <project>/public/diorama.glb
       Vite's HMR picks it up; reload http://localhost:5174/?glb=1
       to see your scene on the planet.

The face-block table matches `buildDiorama.ts` header comment 1:1. Changing
either side means changing both — the validator reads these from here.
"""

import os
import time
import array
import hashlib
from contextlib import contextmanager
import bpy
import mathutils
from bpy.app.handlers import persistent

# ── Cross cube-net geometry (matches buildDiorama.ts / buildGrass.ts) ──────
# IMPORTANT: coordinates below are in BLENDER space (Z-up). The glTF exporter
# is invoked with export_yup=True, so the three-js side receives the scene
# with our Blender Y→Z flip undone. In three-js-speak these tables use
# `z` for what Blender sees as `y` — but everything you author / see in
# Blender uses the native axes listed here.

# Face blocks: 6 × 2×2 squares arranged in a cross on the XY plane.
FACE_BLOCKS = [
    # (name, cube face, x_min, x_max, y_min, y_max)
    ("E", "+Z (front)", -2.0,  0.0, -1.0,  1.0),
    ("A", "+X (right)",  0.0,  2.0, -1.0,  1.0),
    ("B", "-X (left)",  -4.0, -2.0, -1.0,  1.0),
    ("F", "-Z (back)",   2.0,  4.0, -1.0,  1.0),
    ("C", "+Y (top)",   -2.0,  0.0,  1.0,  3.0),
    ("D", "-Y (bottom)", -2.0,  0.0, -3.0, -1.0),
]

# Unfold rows — a mesh's world AABB must fit INSIDE ONE of these. Spanning
# X inside the middle row is fine (the row folds continuously from -X face
# through +Z, +X, -Z), and that's where the road/fence legitimately live.
# Crossing between rows is NOT fine because those edges meet non-adjacent
# faces on the cube.
UNFOLD_ROWS = [
    # (name, x_min, x_max, y_min, y_max)
    ("middle (B, E, A, F)", -4.0, 4.0, -1.0,  1.0),
    ("top (C)",             -2.0, 0.0,  1.0,  3.0),
    ("bottom (D)",          -2.0, 0.0, -3.0, -1.0),
]


# ── Preferences ────────────────────────────────────────────────────────────

class RubicsPrefs(bpy.types.AddonPreferences):
    bl_idname = __name__

    project_path: bpy.props.StringProperty(  # type: ignore[valid-type]
        name="Project Path",
        description="Root of the RubicsWorld repo (the folder that contains public/)",
        default="",
        subtype='DIR_PATH',
    )

    def draw(self, context):
        layout = self.layout
        layout.prop(self, "project_path")
        layout.label(text=f"Target: {_glb_path(context) or '(set project path first)'}")


def _glb_path(context) -> str:
    prefs = context.preferences.addons[__name__].preferences
    root = prefs.project_path
    if not root:
        return ""
    return os.path.join(bpy.path.abspath(root), "public", "diorama.glb")


# ── Collection conventions ─────────────────────────────────────────────────
#
# Two top-level collections carry semantic meaning on export:
#
#   rubics_diorama  — renderable scene (ground, trees, huts, ...). These
#                     meshes arrive in three-js as normal visible objects.
#   rubics_collider — invisible AABB colliders for the walk-mode collision
#                     system. On glb export the plugin stamps each collider
#                     with `obj["rubics_role"] = "collider"` (or
#                     `"collider_dyn"` when the name starts with `_col_dyn_`),
#                     which the glTF exporter carries through as per-node
#                     `extras`, which three-js's GLTFLoader surfaces as
#                     `mesh.userData.rubics_role`. Colliders render in
#                     Blender so you can see/edit them, but the loader
#                     hides them and the walk-mode code tests the player
#                     against each collider's world AABB.
#
# Naming convention inside rubics_collider:
#   _col_<purpose>_<n>       — static (e.g. _col_hut_01, _col_bridge_underpass_1)
#   _col_dyn_<purpose>_<n>   — dynamic (e.g. _col_dyn_car_01); AABB
#                              recomputed every frame from matrixWorld.
#
# Ground / terrain stays in rubics_diorama. Reference guides
# (rubics-guide-*) remain in the scene root — plugin already filters them.

DIORAMA_COLL_NAME  = "rubics_diorama"
COLLIDER_COLL_NAME = "rubics_collider"


def _ensure_collection(scene, name):
    """Create `name` as a direct child of the scene root collection if
    missing, or relink it if it exists orphaned. Returns the collection.
    """
    coll = bpy.data.collections.get(name)
    if coll is None:
        coll = bpy.data.collections.new(name)
        scene.collection.children.link(coll)
        return coll
    # Already exists — verify it's reachable from the scene root, else link.
    reachable = {c.name for c in scene.collection.children_recursive}
    if coll.name not in reachable and coll.name not in {c.name for c in scene.collection.children}:
        scene.collection.children.link(coll)
    return coll


def _move_to_collection(obj, target_coll):
    """Move `obj` so its ONLY collection membership is `target_coll`.
    Idempotent; safe if obj already lives there."""
    if obj.users_collection and len(obj.users_collection) == 1 and obj.users_collection[0] == target_coll:
        return
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    target_coll.objects.link(obj)


@contextmanager
def _with_collider_tags(_context):
    """Stamp rubics_role custom property on every object under the
    rubics_collider collection for the duration of an export. Blender's
    glTF exporter maps custom properties to glTF node `extras`; three-js's
    GLTFLoader surfaces `extras` as `mesh.userData`. Cleaned up on exit so
    the .blend file isn't mutated by an export.
    """
    coll = bpy.data.collections.get(COLLIDER_COLL_NAME)
    if coll is None:
        yield
        return
    orig = []
    try:
        for obj in coll.all_objects:
            had = "rubics_role" in obj.keys()
            prev = obj.get("rubics_role") if had else None
            orig.append((obj, had, prev))
            is_dyn = obj.name.lower().startswith("_col_dyn_")
            obj["rubics_role"] = "collider_dyn" if is_dyn else "collider"
        yield
    finally:
        for obj, had, prev in orig:
            try:
                if not had:
                    if "rubics_role" in obj.keys():
                        del obj["rubics_role"]
                else:
                    obj["rubics_role"] = prev
            except ReferenceError:
                pass


# ── Live mode (auto-export on scene change) ────────────────────────────────

# Module-scoped state — BoolProperty on Scene would persist per-blend, but
# timers and handlers need a stable cross-scene reference. Kept minimal:
# one flag for the toggle, a dirty-bit the depsgraph handler sets, and the
# last-export wall-clock so the panel can show "exported Xs ago".
_LIVE = {
    "enabled": False,
    "dirty": False,
    "last_export_wall": 0.0,
    "last_export_ok": True,
    "last_path": "",
    "last_fingerprint": "",  # set after each successful export
}

#: Blender datablock types whose updates we care about. Selection / view
#: rotations / depsgraph housekeeping all get filtered out — only changes
#: to these types can flip the dirty bit.
_LIVE_RELEVANT_TYPES = {
    'Object', 'Mesh', 'Curve', 'Armature',
    'Material', 'Action', 'ShapeKey', 'Light', 'Camera',
}


def _scene_fingerprint() -> str:
    """Cheap content hash: object transforms + mesh vert counts + modifier
    signatures + action frame range. Same fingerprint twice in a row ⇒ the
    user-visible authoring state hasn't actually changed (the depsgraph may
    have ticked anyway for reasons we don't care about — viewport rotation,
    driver re-eval, animation preview, etc.)
    """
    h = hashlib.blake2b(digest_size=16)
    for obj in sorted(bpy.data.objects, key=lambda o: o.name):
        if obj.name.startswith("rubics-guide-"):
            continue
        m = obj.matrix_world
        # Round to 5 decimal places so sub-micron noise doesn't spoof changes.
        row_bytes = ";".join(
            f"{v:.5f}" for v in (
                m[0][0], m[0][1], m[0][2], m[0][3],
                m[1][0], m[1][1], m[1][2], m[1][3],
                m[2][0], m[2][1], m[2][2], m[2][3],
            )
        )
        h.update(f"{obj.name}|{obj.type}|{row_bytes}|".encode())
        if obj.type == 'MESH' and obj.data is not None:
            h.update(f"v{len(obj.data.vertices)}p{len(obj.data.polygons)}|".encode())
            # Hash vertex-color attribute bytes. Vertex Paint strokes mutate
            # colours without changing vert/poly counts, so the coarse
            # topology hash above is identical before/after a stroke. Without
            # the colour bytes folded in, Live Mode would short-circuit and
            # the grass mask painted on the ground never reaches three-js.
            # Cost: 16 bytes/vert per colour layer (FLOAT_COLOR RGBA), which
            # is negligible for a ground mesh of a few thousand verts.
            for ca in getattr(obj.data, "color_attributes", []) or []:
                h.update(f"CA|{ca.name}|{ca.domain}|{ca.data_type}|".encode())
                try:
                    buf = array.array('f', [0.0] * (len(ca.data) * 4))
                    ca.data.foreach_get("color", buf)
                    h.update(buf.tobytes())
                except (AttributeError, TypeError, RuntimeError):
                    # Some storage variants (e.g. BYTE_COLOR on older
                    # Blender) may reject foreach_get("color", float[]).
                    # Fall back to per-item access — slow but correct.
                    for item in ca.data:
                        c = getattr(item, "color", None)
                        if c is not None:
                            h.update(f"{c[0]:.4f},{c[1]:.4f},{c[2]:.4f},{c[3]:.4f}|".encode())
        for mod in getattr(obj, "modifiers", []) or []:
            h.update(f"{mod.type}:{mod.name}|".encode())
    for act in sorted(bpy.data.actions, key=lambda a: a.name):
        fs, fe = act.frame_range
        h.update(f"ACT|{act.name}|{fs:.3f}|{fe:.3f}|".encode())
    return h.hexdigest()


def _isolate_hide_set(context) -> set:
    """Return the set of objects that should NOT make it into the export
    when isolate mode is on: rubics-guide-* helpers (authoring aids) and
    any mesh whose world XY AABB is entirely outside the 6 face-block
    rectangles. Objects spanning the whole net (terrain / ground with AABB
    reaching into every block) naturally pass the overlap test — no
    special-casing required.
    """
    hidden = set()
    blocks = [(x0, x1, y0, y1) for (_n, _f, x0, x1, y0, y1) in FACE_BLOCKS]
    for obj in context.scene.objects:
        if obj.name.startswith("rubics-guide-"):
            hidden.add(obj)
            continue
        if obj.type != 'MESH':
            continue
        mw = obj.matrix_world
        xs = []
        ys = []
        for corner in obj.bound_box:
            wv = mw @ mathutils.Vector(corner)
            xs.append(wv.x)
            ys.append(wv.y)
        if not xs:
            continue
        xmin, xmax = min(xs), max(xs)
        ymin, ymax = min(ys), max(ys)
        overlaps = False
        for (bx0, bx1, by0, by1) in blocks:
            if xmax >= bx0 and xmin <= bx1 and ymax >= by0 and ymin <= by1:
                overlaps = True
                break
        if not overlaps:
            hidden.add(obj)
    return hidden


@contextmanager
def _with_isolate(context):
    """Temporarily set hide_viewport=True on isolate-hidden objects so the
    glTF exporter's `use_visible=True` filter skips them. Restores the
    original flags on exit, even if the export raises. No-op when the
    scene's rubics_isolate_export toggle is off.
    """
    scene = context.scene
    if not getattr(scene, "rubics_isolate_export", False):
        yield
        return
    to_hide = _isolate_hide_set(context)
    orig = {obj: obj.hide_viewport for obj in to_hide}
    try:
        for obj in to_hide:
            obj.hide_viewport = True
        yield
    finally:
        for obj, was in orig.items():
            # Object may have been deleted mid-export (unlikely, but defend).
            try:
                obj.hide_viewport = was
            except ReferenceError:
                pass


# ── KHR_audio_emitter post-export patcher ─────────────────────────────────
#
# Blender's Khronos glTF exporter (io_scene_gltf2) skips Speaker objects —
# they're not Mesh / Camera / Light / Empty so they never reach the node
# graph. To get them into the .glb, we post-process: read the .glb, locate
# its JSON chunk, inject `audio[]`, `audioSources[]`, `audioEmitters[]`
# arrays under `extensions.KHR_audio_emitter`, append a node per Speaker to
# `nodes[]`, parent it under the matching Blender parent (by name) or to
# the scene root, and re-pack.
#
# Supported Speaker custom properties:
#   rubics_audio_key       — override the loop key (default: speaker.name)
#   rubics_audio_params    — JSON string of LoopDef.params (verbatim shape
#                            from registry.json — vol/rate/lowpass/etc with
#                            base/modulator/min/max/invert)
#   rubics_audio_modulator — modulator name (string or comma-separated list)
#   rubics_audio_vol       — base volume (overrides speaker.volume if set)
#
# The audio file itself is referenced by URI relative to public/audio/. The
# Blender Speaker.sound.filepath is expected to point at <project>/public/
# audio/<file>.ogg — we extract just the basename and prefix with `audio/`.

import struct
import json
import re

GLB_MAGIC = 0x46546C67  # 'glTF'
GLB_VERSION = 2
CHUNK_JSON = 0x4E4F534A  # 'JSON'
CHUNK_BIN = 0x004E4942   # 'BIN\0'


def _zup_translation_to_yup(v) -> tuple[float, float, float]:
    """Mirror the export_yup=True axis swap the glTF exporter applies.
    Z-up → Y-up: (x, y, z) → (x, z, -y).
    """
    return (float(v[0]), float(v[2]), -float(v[1]))


def _zup_quaternion_to_yup(q) -> tuple[float, float, float, float]:
    """Compose the Z-up to Y-up rotation onto an arbitrary quaternion. The
    swap is a -90° rotation around X (mathutils encodes as (x,y,z,w)).
    """
    import mathutils
    swap = mathutils.Quaternion((1, 0, 0), -1.5707963267948966)  # -π/2 around X
    out = swap @ q
    return (out.x, out.y, out.z, out.w)


def _audio_uri_for_speaker(spk) -> str | None:
    """Resolve the speaker's referenced sound file to a path of the form
    `audio/<file>.ogg` — relative to the project's public/ directory, which
    is where the runtime fetches assets from.
    """
    sound = spk.data.sound if spk and spk.data else None
    if not sound or not sound.filepath:
        return None
    abs_path = bpy.path.abspath(sound.filepath)
    base = os.path.basename(abs_path)
    if not base:
        return None
    return f"audio/{base}"


def _sample_speaker_volume_envelope(spk_data, scene) -> dict | None:
    """If the Speaker datablock has volume keyframes (or is driven by an
    fcurve), sample the value across [scene.frame_start, scene.frame_end]
    and return an envelope dict consumed by the runtime audio bus.

    Format: { fps, samples: [vol_at_frame_0, vol_at_frame_1, ...] }
    The runtime multiplies these values into the loop's base gain on each
    frame, with `fps` letting it map mixer.time → sample index.
    """
    anim = getattr(spk_data, 'animation_data', None)
    action = anim.action if anim else None
    fcurves = action.fcurves if action else None
    has_volume_curve = False
    if fcurves:
        for fc in fcurves:
            if fc.data_path == 'volume':
                has_volume_curve = True
                break
    if not has_volume_curve:
        return None
    f0, f1 = int(scene.frame_start), int(scene.frame_end)
    if f1 < f0: return None
    fps = scene.render.fps / max(1.0, scene.render.fps_base)
    # Save + restore the playhead so the export doesn't permanently move
    # the user's frame cursor as a side-effect of sampling.
    saved_frame = scene.frame_current
    samples = []
    try:
        for f in range(f0, f1 + 1):
            scene.frame_set(f)
            v = float(spk_data.volume)
            samples.append(max(0.0, min(1.0, v)))
    finally:
        scene.frame_set(saved_frame)
    return {'fps': fps, 'samples': samples}


def _collect_speakers(scene) -> list[dict]:
    """Walk scene Speaker objects and produce a normalised description of
    each one. Records local (parent-relative) transform when parented,
    world transform otherwise. Skips muted speakers (use Blender's mute
    toggle to author audio that won't ship)."""
    out = []
    for obj in scene.objects:
        if obj.type != 'SPEAKER':
            continue
        spk = obj.data
        if not spk or spk.muted:
            continue
        uri = _audio_uri_for_speaker(obj)
        if not uri:
            print(f"[rubics-audio] skipping {obj.name}: no sound file")
            continue
        # Use parent's name as the join key — patcher matches by node name in
        # the exported glb.
        parent_name = obj.parent.name if obj.parent else None
        # Local transform if parented; else world.
        if obj.parent:
            mat = obj.matrix_local
        else:
            mat = obj.matrix_world
        loc, rot, _scale = mat.decompose()
        translation = _zup_translation_to_yup(loc)
        rotation = _zup_quaternion_to_yup(rot)

        params_json = obj.get('rubics_audio_params', '')
        params = None
        if params_json:
            try:
                params = json.loads(params_json) if isinstance(params_json, str) else dict(params_json)
            except Exception as e:
                print(f"[rubics-audio] {obj.name}: malformed rubics_audio_params: {e}")
        modulator = obj.get('rubics_audio_modulator', None)
        if isinstance(modulator, str) and ',' in modulator:
            modulator = [m.strip() for m in modulator.split(',') if m.strip()]
        rubics_extras = {}
        if params: rubics_extras['params'] = params
        if modulator: rubics_extras['modulator'] = modulator
        rubics_vol = obj.get('rubics_audio_vol', None)
        if rubics_vol is not None: rubics_extras['vol'] = float(rubics_vol)
        rubics_key = obj.get('rubics_audio_key', None)
        if rubics_key: rubics_extras['key'] = str(rubics_key)
        # WYSIWYG: keyframed Speaker.volume → baked envelope. Runtime
        # multiplies the envelope into the loop's base gain so authored
        # volume animations replay verbatim. Skipped if Speaker volume
        # has no fcurves.
        envelope = _sample_speaker_volume_envelope(spk, scene)
        if envelope: rubics_extras['envelope'] = envelope

        # Volume — clamp to [0,1] so we hand the runtime a sane value.
        gain = max(0.0, min(1.0, float(spk.volume)))

        out.append({
            'name': str(rubics_key) if rubics_key else obj.name,
            'parent_name': parent_name,
            'translation': list(translation),
            'rotation': list(rotation),
            'uri': uri,
            'gain': gain,
            'refDistance': float(spk.distance_reference),
            'maxDistance': float(spk.distance_max) if spk.distance_max < 1e6 else 25.0,
            # Blender's `attenuation` ≈ Web Audio's `rolloffFactor`. 1.0 is
            # the project's standard "linear from full to silent across the
            # ref→max band."
            'rolloffFactor': float(spk.attenuation) if spk.attenuation > 0 else 1.0,
            'coneInnerAngle': float(spk.cone_angle_inner),
            'coneOuterAngle': float(spk.cone_angle_outer),
            'extras_rubics': rubics_extras or None,
        })
    return out


def _patch_glb_with_audio(path: str, speakers: list[dict]) -> bool:
    """Inject KHR_audio_emitter into the .glb at `path`. No-op (returns
    True) when there are no speakers. Returns False on parse error.
    """
    if not speakers:
        return True
    try:
        with open(path, 'rb') as f:
            data = f.read()
        # Header: 'glTF' (4) + version (4) + total length (4) = 12 bytes.
        if len(data) < 12:
            print("[rubics-audio] glb too small")
            return False
        magic, version, total = struct.unpack('<III', data[:12])
        if magic != GLB_MAGIC or version != GLB_VERSION:
            print(f"[rubics-audio] glb bad magic/version: {magic:x}, {version}")
            return False
        # Chunk 0 must be JSON.
        chunk0_len, chunk0_type = struct.unpack('<II', data[12:20])
        if chunk0_type != CHUNK_JSON:
            print("[rubics-audio] first glb chunk not JSON")
            return False
        json_bytes = data[20:20 + chunk0_len]
        gltf = json.loads(json_bytes.rstrip(b' ').decode('utf-8'))
        rest = data[20 + chunk0_len:]  # all remaining chunks (BIN + any others)

        # Ensure the buckets exist.
        nodes = gltf.setdefault('nodes', [])
        scenes = gltf.setdefault('scenes', [{'nodes': []}])
        scene = scenes[gltf.get('scene', 0)]
        scene_nodes = scene.setdefault('nodes', [])
        ext_used = gltf.setdefault('extensionsUsed', [])
        if 'KHR_audio_emitter' not in ext_used:
            ext_used.append('KHR_audio_emitter')

        # Build name → node-index map for parent lookup.
        name_to_idx = {n.get('name'): i for i, n in enumerate(nodes) if n.get('name')}

        # Top-level extension structure: audio + audioSources + audioEmitters.
        audio_arr = []
        sources_arr = []
        emitters_arr = []

        # Reuse audio entries by URI so two emitters pointing at the same
        # file share one audio block.
        uri_to_audio_idx: dict[str, int] = {}

        for spk in speakers:
            uri = spk['uri']
            audio_idx = uri_to_audio_idx.get(uri)
            if audio_idx is None:
                audio_idx = len(audio_arr)
                audio_arr.append({'uri': uri, 'mimeType': 'audio/ogg' if uri.endswith('.ogg') else 'audio/mpeg'})
                uri_to_audio_idx[uri] = audio_idx
            source_idx = len(sources_arr)
            sources_arr.append({'audio': audio_idx, 'gain': 1.0, 'loop': True, 'autoPlay': True})
            emitter = {
                'type': 'positional',
                'name': spk['name'],
                'gain': spk['gain'],
                'sources': [source_idx],
                'positional': {
                    'refDistance': spk['refDistance'],
                    'maxDistance': spk['maxDistance'],
                    'rolloffFactor': spk['rolloffFactor'],
                    'coneInnerAngle': spk['coneInnerAngle'],
                    'coneOuterAngle': spk['coneOuterAngle'],
                    'distanceModel': 'linear',
                },
            }
            if spk['extras_rubics']:
                emitter['extras'] = {'rubics': spk['extras_rubics']}
            emitter_idx = len(emitters_arr)
            emitters_arr.append(emitter)

            # Add a node carrying this emitter. Parent it to the matching
            # named node if present, else attach to scene root.
            new_node = {
                'name': f"audio:{spk['name']}",
                'translation': spk['translation'],
                'rotation': spk['rotation'],
                'extensions': {'KHR_audio_emitter': {'emitter': emitter_idx}},
            }
            new_node_idx = len(nodes)
            nodes.append(new_node)
            parent_idx = name_to_idx.get(spk['parent_name']) if spk['parent_name'] else None
            if parent_idx is not None:
                parent = nodes[parent_idx]
                parent.setdefault('children', []).append(new_node_idx)
            else:
                scene_nodes.append(new_node_idx)

        gltf.setdefault('extensions', {})['KHR_audio_emitter'] = {
            'audio': audio_arr,
            'audioSources': sources_arr,
            'audioEmitters': emitters_arr,
        }

        # Re-serialize JSON chunk — pad to 4-byte alignment with spaces (per
        # glb spec; trailing spaces are a no-op for JSON parsers).
        new_json = json.dumps(gltf, separators=(',', ':')).encode('utf-8')
        pad = (-len(new_json)) % 4
        if pad: new_json += b' ' * pad
        new_total = 12 + 8 + len(new_json) + len(rest)
        with open(path, 'wb') as f:
            f.write(struct.pack('<III', GLB_MAGIC, GLB_VERSION, new_total))
            f.write(struct.pack('<II', len(new_json), CHUNK_JSON))
            f.write(new_json)
            f.write(rest)
        print(f"[rubics-audio] injected {len(emitters_arr)} emitter(s) into {os.path.basename(path)}")
        return True
    except Exception as e:
        print(f"[rubics-audio] glb patch failed: {e}")
        return False


def _do_export_current(path: str) -> tuple[bool, int]:
    """Run the glTF exporter with the pipeline flags. Returns (ok, size).
    Safe to call from a timer — doesn't touch the active operator's stack.
    """
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        # v2: snapshot speakers BEFORE the export's _with_isolate strips
        # invisible objects. Speakers are SPEAKER type, not MESH, so the
        # exporter ignores them — we patch them in post.
        speakers = _collect_speakers(bpy.context.scene)
        # Stack both context managers: isolate strips rubics-guide-* /
        # outside-block meshes, collider-tag stamps rubics_role so the
        # loader can split colliders from renderable diorama on the other
        # side. export_extras=True is critical — without it the custom
        # properties don't reach the glTF extras field.
        with _with_isolate(bpy.context), _with_collider_tags(bpy.context):
            bpy.ops.export_scene.gltf(
                filepath=path,
                export_format='GLB',
                export_yup=True,
                export_apply=True,
                export_animations=True,
                export_skins=True,
                export_morph=True,
                export_cameras=False,
                export_lights=False,
                use_visible=True,
                export_extras=True,
                # WYSIWYG animation pipeline (v0.2.0):
                # - force_sampling: bake DRIVERS and CONSTRAINTS to keyframes.
                #   Without this, a windmill spun by a Python driver
                #   `#frame * 0.1` exports as a static mesh (driver doesn't
                #   translate to glTF). With this, every frame in the scene
                #   range is sampled into the action.
                # - optimize_animation_size=False: keep ALL sampled keyframes.
                #   The optimizer drops "redundant" frames when motion is
                #   nearly constant — fine for hero animations, but it
                #   silently flattens subtle in-between motion (the kind
                #   that makes diorama loops feel alive).
                # - frame_step=1: sample every frame (matches scene fps).
                export_force_sampling=True,
                export_optimize_animation_size=False,
                export_frame_step=1,
            )
        # Post-process: inject KHR_audio_emitter into the freshly-written glb.
        # Failure is non-fatal — geometry export still succeeded.
        if speakers:
            _patch_glb_with_audio(path, speakers)
        size = os.path.getsize(path) if os.path.exists(path) else 0
        return True, size
    except Exception as e:
        print(f"[rubics-live] export failed: {e}")
        return False, 0


@persistent
def _live_depsgraph_handler(scene, depsgraph):
    """Fired on EVERY depsgraph update when Blender has finished recomputing.
    Filter aggressively — selection changes, viewport orbits, animation
    preview ticks, and driver re-evaluations all trigger this handler even
    though nothing the user cares about actually changed. We only flip the
    dirty bit if at least one relevant datablock had a transform / geometry
    / shading mutation; the fingerprint check in _live_tick is the final
    gate before any bytes hit the disk.
    """
    if not _LIVE["enabled"]:
        return
    for upd in depsgraph.updates:
        # Only real data mutations — not mere re-evaluation triggered by
        # selection or view state.
        if not (upd.is_updated_transform or upd.is_updated_geometry or upd.is_updated_shading):
            continue
        if type(upd.id).__name__ in _LIVE_RELEVANT_TYPES:
            _LIVE["dirty"] = True
            return


def _live_tick():
    """Timer callback — runs every LIVE_DEBOUNCE seconds while live mode is
    on. Exports iff the dirty bit was set since the last tick. Returns the
    next interval, or None to stop the timer.
    """
    if not _LIVE["enabled"]:
        return None
    # Don't export mid-edit — mesh data can be in an intermediate state.
    if bpy.context.mode != 'OBJECT':
        return LIVE_DEBOUNCE
    if not _LIVE["dirty"]:
        return LIVE_DEBOUNCE
    _LIVE["dirty"] = False

    # Second-layer gate: even if the depsgraph flagged a real mutation, the
    # resulting scene state may match what we already exported (undo/redo
    # round trip, modal operator cancelled, etc.). Fingerprint check skips
    # the write when the authoring state is byte-equivalent.
    fp = _scene_fingerprint()
    if fp == _LIVE["last_fingerprint"]:
        return LIVE_DEBOUNCE

    # Resolve path via preferences without a context arg (timers get no ctx).
    try:
        prefs = bpy.context.preferences.addons[__name__].preferences
        root = prefs.project_path
    except Exception:
        root = ""
    if not root:
        return LIVE_DEBOUNCE
    path = os.path.join(bpy.path.abspath(root), "public", "diorama.glb")
    ok, size = _do_export_current(path)
    _LIVE["last_export_wall"] = time.time()
    _LIVE["last_export_ok"] = ok
    _LIVE["last_path"] = path
    if ok:
        _LIVE["last_fingerprint"] = fp
        print(f"[rubics-live] auto-exported {size} bytes → {path}")
    return LIVE_DEBOUNCE


def _live_start():
    if _live_depsgraph_handler not in bpy.app.handlers.depsgraph_update_post:
        bpy.app.handlers.depsgraph_update_post.append(_live_depsgraph_handler)
    _LIVE["enabled"] = True
    _LIVE["dirty"] = True            # force first export on next tick
    _LIVE["last_fingerprint"] = ""   # so fingerprint compare can't short-circuit
    if not bpy.app.timers.is_registered(_live_tick):
        bpy.app.timers.register(_live_tick, first_interval=LIVE_DEBOUNCE)


def _live_stop():
    _LIVE["enabled"] = False
    if _live_depsgraph_handler in bpy.app.handlers.depsgraph_update_post:
        bpy.app.handlers.depsgraph_update_post.remove(_live_depsgraph_handler)
    if bpy.app.timers.is_registered(_live_tick):
        bpy.app.timers.unregister(_live_tick)


# ── Validation ─────────────────────────────────────────────────────────────

#: object names that are allowed to span the entire cross cube-net without
#: being flagged — these are the continuous ground surfaces that every cell
#: render clips per-face. buildDiorama's own terrain + sphere-terrain use
#: these names.
WHOLE_NET_ALLOWED = {"terrain", "sphere-terrain", "ground"}

#: Below this depth we warn; above is treated as modelling noise.
SUBTERRAIN_NOISE = 0.10

#: Hard bounds of the whole 8×6 cross. Anything outside is clearly stray.
DOMAIN_X = (-4.0, 4.0)
DOMAIN_Y = (-3.0, 3.0)

#: Portal-region height ceiling — matches `uMaxHeight` in TileGrid.tsx.
#: The sphere-projection shader saturates prop elevation against a bezier
#: curve normalised over [0, MAX_HEIGHT]; authoring above this just clamps.
MAX_HEIGHT = 1.0

#: Live-mode debounce (seconds) — minimum gap between auto-exports. The
#: depsgraph fires constantly during editing, so we coalesce updates into
#: at most one export per this interval.
LIVE_DEBOUNCE = 1.5


def _name_prefix_allowed(name: str) -> bool:
    base = name.lower().split('.')[0]
    return base in WHOLE_NET_ALLOWED


def validate_scene(context):
    """Return a list of (level, message) tuples — WARNING / ERROR.

    Blender-native axes: X, Y = ground plane; Z = height.

    Validator design: the sphere-projection pipeline stitches cross-row
    meshes seamlessly (each tile's clip planes chop the mesh to its cell;
    shared cube edges produce identical world positions from both sides).
    So row containment is NOT a hard rule — only subdivision, sub-terrain
    dipping, and stray-from-domain actually break the render.
    """
    issues = []
    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue
        if obj.name.startswith("rubics-guide-"):
            continue
        if _name_prefix_allowed(obj.name):
            continue  # Terrain / ground — expected to span everything.

        corners = [obj.matrix_world @ mathutils.Vector(c) for c in obj.bound_box]
        xs = [v.x for v in corners]
        ys = [v.y for v in corners]
        zs = [v.z for v in corners]
        x_min, x_max = min(xs), max(xs)
        y_min, y_max = min(ys), max(ys)
        z_min, z_max = min(zs), max(zs)

        # ERROR — mesh is completely outside the 8×6 cross domain. Nothing
        # inside the addon renders meshes there; clip planes reject it from
        # every tile pass. Usually a lost object that drifted off the grid.
        if (x_max < DOMAIN_X[0] or x_min > DOMAIN_X[1] or
            y_max < DOMAIN_Y[0] or y_min > DOMAIN_Y[1]):
            issues.append(('ERROR',
                f"'{obj.name}' is entirely outside the cube-net domain "
                f"(x={x_min:.2f}..{x_max:.2f}, y={y_min:.2f}..{y_max:.2f}). "
                f"Domain is x∈[-4,4], y∈[-3,3]; this mesh won't render."))

        # vyapti PV1 — long meshes need subdivision for the sphere projection.
        # This is the actual quality gate: without enough verts along the long
        # axis, the mesh chords between sparse vertices and cuts through the
        # sphere (invisible / wrong-elevation rendering).
        long_axis = max(x_max - x_min, y_max - y_min)
        if long_axis > 1.0:
            mesh = obj.data
            nverts = len(mesh.vertices)
            if nverts < 8 * long_axis:
                issues.append(('WARNING',
                    f"'{obj.name}' spans {long_axis:.1f} flat-units with only "
                    f"{nverts} verts — add loop cuts (≥8 per unit) or it will "
                    f"chord through the sphere."))

        # Sub-terrain dip. Ignore first 10 cm as modelling noise.
        if z_min < -SUBTERRAIN_NOISE:
            issues.append(('WARNING',
                f"'{obj.name}' extends {abs(z_min):.2f} below ground "
                f"(z_min={z_min:.3f}) — will be buried in the planet interior."))

    return issues


# ── Operators ──────────────────────────────────────────────────────────────

class RUBICS_OT_Import(bpy.types.Operator):
    bl_idname = "rubics.import_diorama"
    bl_label = "Import Diorama"
    bl_description = "Clear existing objects and load <project>/public/diorama.glb"
    bl_options = {'REGISTER', 'UNDO'}

    def execute(self, context):
        path = _glb_path(context)
        if not path:
            self.report({'ERROR'}, "Set Project Path in addon preferences first")
            return {'CANCELLED'}
        if not os.path.exists(path):
            self.report({'ERROR'}, f"Not found: {path}")
            return {'CANCELLED'}

        # DO NOT call bpy.ops.wm.read_factory_settings from inside an operator
        # — it invalidates the running operator's own RNA path and segfaults
        # Blender on the very next self.report / return. Clear via the data
        # API instead, which is scope-safe.
        for obj in list(bpy.data.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        # Purge orphaned blocks so the scene doesn't accumulate detritus
        # across successive Import cycles.
        for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.curves,
                     bpy.data.actions, bpy.data.armatures):
            for item in list(coll):
                if item.users == 0:
                    coll.remove(item)

        # Snapshot existing objects so the post-import diff tells us
        # exactly which objects came from this glb (Blender's importer
        # appends to bpy.data.objects rather than returning a list).
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=path)
        imported = [o for o in bpy.data.objects if o not in before]

        # Sort imported objects into rubics_diorama / rubics_collider
        # based on the `rubics_role` custom property carried through the
        # glTF extras field. Anything else (renderable diorama meshes,
        # the ground, lights, etc) goes to rubics_diorama.
        diorama_coll  = _ensure_collection(context.scene, DIORAMA_COLL_NAME)
        collider_coll = _ensure_collection(context.scene, COLLIDER_COLL_NAME)
        moved_d = 0
        moved_c = 0
        for obj in imported:
            role = obj.get("rubics_role", None)
            if role in ("collider", "collider_dyn"):
                _move_to_collection(obj, collider_coll)
                # Display-only convention: wireframe + red so colliders
                # read as authoring primitives, matching Add Collider.
                obj.display_type = 'WIRE'
                obj.show_in_front = True
                obj.color = (1.0, 0.4, 0.4, 1.0)
                obj.hide_render = True
                moved_c += 1
            else:
                _move_to_collection(obj, diorama_coll)
                moved_d += 1

        self.report(
            {'INFO'},
            f"Imported {os.path.basename(path)}: {moved_d} → {DIORAMA_COLL_NAME}, "
            f"{moved_c} → {COLLIDER_COLL_NAME}",
        )
        return {'FINISHED'}


class RUBICS_OT_InitScene(bpy.types.Operator):
    """Create a fresh diorama scene from scratch — no existing glb required.

    Drops a single 'ground' plane at origin, 8×6 (matches the cube-net
    bounding box). The material carries a generated alpha mask so only
    the 6 face-block rectangles render opaque; the four cross-corners
    outside the net are transparent. Visually tells the author exactly
    where they can place content.

    The mask image is created in-memory (bpy.data.images.new + pixel
    array write), then packed so it travels inside the .blend file. No
    external PNG asset required. glTF export carries the embedded image
    through to the three-js side as an alphaMode=BLEND material.
    """
    bl_idname = "rubics.init_scene"
    bl_label = "Init Scene"
    bl_description = "Create a fresh ground plane (8×6) with a cube-net alpha mask"
    bl_options = {'REGISTER', 'UNDO'}

    def execute(self, context):
        # Refuse to clobber an existing ground / terrain — preserves ongoing
        # authoring. User must delete first to reinit.
        for name in ("ground", "terrain"):
            if name in bpy.data.objects:
                self.report({'ERROR'}, f"'{name}' already exists — delete it before Init")
                return {'CANCELLED'}

        # 1. Build a subdivided 8×6 grid at Z=0 via bmesh. A flat
        #    primitive_plane_add produces a 2-triangle plane (4 verts) —
        #    when the three-js side sphere-projects those, the giant
        #    triangles CHORD THROUGH the sphere interior and the ground
        #    renders inside-out / invisible (project vyapti: multi-face
        #    meshes need ≥ ~8 subdivisions per cube face). 48×36 = 8 cuts
        #    per face on the middle row (4 faces × 8 = 32, rounded up +
        #    safety margin). UVs span [0, 1] so our cube-net alpha mask
        #    image applies exactly once across the plane.
        import bmesh
        COLS, ROWS = 48, 36
        W, D = 8.0, 6.0
        bm = bmesh.new()
        uv_layer = bm.loops.layers.uv.new()
        grid = []
        for j in range(ROWS + 1):
            row = []
            for i in range(COLS + 1):
                x = -W * 0.5 + (i / COLS) * W
                y = -D * 0.5 + (j / ROWS) * D
                row.append(bm.verts.new((x, y, 0.0)))
            grid.append(row)
        for j in range(ROWS):
            for i in range(COLS):
                f = bm.faces.new([
                    grid[j][i], grid[j][i + 1],
                    grid[j + 1][i + 1], grid[j + 1][i],
                ])
                for loop in f.loops:
                    lx, ly = loop.vert.co.x, loop.vert.co.y
                    loop[uv_layer].uv = (
                        (lx + W * 0.5) / W,
                        (ly + D * 0.5) / D,
                    )
        bm.normal_update()
        mesh = bpy.data.meshes.new("ground-mesh")
        bm.to_mesh(mesh)
        bm.free()
        obj = bpy.data.objects.new("ground", mesh)
        # Ensure the two semantic collections exist and drop the ground into
        # rubics_diorama. rubics_collider is created empty, ready for
        # "Add Collider" invocations. See _with_collider_tags for why the
        # split matters at export time.
        diorama_coll  = _ensure_collection(context.scene, DIORAMA_COLL_NAME)
        _ensure_collection(context.scene, COLLIDER_COLL_NAME)
        diorama_coll.objects.link(obj)
        context.view_layer.objects.active = obj
        obj.select_set(True)

        # 2. Generate the alpha mask. 4:3 aspect matches 8×6; 256×192 gives
        #    sharp face-block borders without bloating the .blend.
        W, H = 256, 192
        img = bpy.data.images.new(
            name="rubics-cube-net-mask",
            width=W, height=H,
            alpha=True,
        )
        pixels = [0.0] * (W * H * 4)  # RGBA, all transparent
        # Paint the 6 face-block rectangles in white (opaque).
        # Blender XY → image pixel mapping: X∈[-4,4]→u∈[0,W], Y∈[-3,3]→v∈[0,H].
        # Blender image pixels are stored bottom-up; y low = pixel row 0.
        for (_name, _face, x0, x1, y0, y1) in FACE_BLOCKS:
            u0 = max(0, int((x0 + 4.0) / 8.0 * W))
            u1 = min(W, int((x1 + 4.0) / 8.0 * W))
            v0 = max(0, int((y0 + 3.0) / 6.0 * H))
            v1 = min(H, int((y1 + 3.0) / 6.0 * H))
            for py in range(v0, v1):
                base = py * W * 4
                for px in range(u0, u1):
                    idx = base + px * 4
                    pixels[idx]     = 1.0
                    pixels[idx + 1] = 1.0
                    pixels[idx + 2] = 1.0
                    pixels[idx + 3] = 1.0
        img.pixels[:] = pixels
        img.pack()

        # 3. Material. Principled BSDF base colour = TERRAIN_GREEN to match
        #    the three-js ground. Alpha from the mask's alpha channel.
        mat = bpy.data.materials.new("rubics-ground")
        mat.use_nodes = True
        mat.blend_method = 'BLEND'
        nt = mat.node_tree
        # Clear the default scatter of nodes and start clean.
        for n in list(nt.nodes):
            nt.nodes.remove(n)
        out_node = nt.nodes.new("ShaderNodeOutputMaterial")
        out_node.location = (400, 0)
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        bsdf.location = (100, 0)
        bsdf.inputs["Base Color"].default_value = (0.62, 0.76, 0.50, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.9
        if "Metallic" in bsdf.inputs:
            bsdf.inputs["Metallic"].default_value = 0.0
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.location = (-300, 0)
        tex.image = img
        # Alpha is linear data — tag non-color so colour management doesn't
        # gamma-shift the mask edges.
        tex.image.colorspace_settings.name = 'Non-Color'
        nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
        nt.links.new(bsdf.outputs["BSDF"], out_node.inputs["Surface"])

        # 4. Assign material.
        obj.data.materials.clear()
        obj.data.materials.append(mat)

        # 5. Density layers. Two POINT-domain FLOAT_COLOR attributes on the
        #    ground mesh: `grass_density` and `flower_density`, both solid
        #    white (R=1 ⇒ allow-all). Ordering matters — glTF exports color
        #    attributes as COLOR_0, COLOR_1 in list order, and the three-js
        #    side reads COLOR_0 as grass / COLOR_1 as flower. Paint them in
        #    Vertex Paint mode with the corresponding layer active.
        _ensure_density_layers(obj)

        self.report({'INFO'}, "Initialized: 'ground' (8×6) with cube-net mask + density layers")
        return {'FINISHED'}


# Authoring-side layer names. glTF semantic names (COLOR_0/1/2) are
# positional, so the three-js side relies on these being created in this
# exact order. Each migrates from the historical names so prior paint values
# survive a plugin upgrade:
#   grass     ← grass_density / Color
#   flowers   ← flower_density / Color.001
#   colliders ← Color.002 (or fresh white)
GRASS_LAYER     = "grass"
FLOWERS_LAYER   = "flowers"
COLLIDERS_LAYER = "colliders"
DENSITY_LAYERS  = (GRASS_LAYER, FLOWERS_LAYER, COLLIDERS_LAYER)
# Aliases tried (in order) when migrating a layer's paint values during
# rename / reorder. First match wins.
LAYER_ALIASES = {
    GRASS_LAYER:     ("grass", "grass_density", "Color"),
    FLOWERS_LAYER:   ("flowers", "flower_density", "Color.001"),
    COLLIDERS_LAYER: ("colliders", "walk", "walk_density", "Color.002"),
}


def _ensure_density_layers(obj):
    """Idempotently establish three POINT-domain FLOAT_COLOR attributes on
    the given mesh, in this exact order:

        COLOR_0 → grass      (grass distribution gate, R-channel = density)
        COLOR_1 → flowers    (flower distribution gate)
        COLOR_2 → colliders  (walk-mode no-go gate; black = blocked)

    Why ordering matters: glTF semantic naming is positional. three.js's
    GLTFLoader maps COLOR_0 → `geometry.attributes.color`, COLOR_1 →
    `color_1`, COLOR_2 → `color_2`. Names get lost in glTF; positions don't.

    Migration: when run on a mesh authored under the older naming
    convention (grass_density / flower_density, or Blender defaults
    Color / Color.001 / Color.002), this captures their paint values
    BEFORE any deletion and restores them under the new names. Re-running
    the operator on an already-correct mesh is a no-op.

    Strips any extra color attributes beyond the three so the export
    contract stays predictable (otherwise a stray fourth/fifth layer
    pushes COLOR_2 to COLOR_3 and the three-js reader breaks).
    """
    mesh = obj.data
    attrs = mesh.color_attributes

    def _find(name):
        try:
            ca = attrs.get(name)
            if ca is not None:
                return ca
        except AttributeError:
            pass
        for c in list(attrs):
            if c.name == name:
                return c
        return None

    def _capture_values(name):
        ca = _find(name)
        if ca is None:
            return None
        n = len(ca.data)
        buf = array.array('f', [0.0] * (n * 4))
        try:
            ca.data.foreach_get("color", buf)
            return list(buf)
        except (AttributeError, TypeError, RuntimeError):
            return [ch for item in ca.data for ch in (item.color[0], item.color[1], item.color[2], item.color[3])]

    def _create_solid_white(name, saved=None):
        ca = attrs.new(name=name, type='FLOAT_COLOR', domain='POINT')
        n = len(ca.data)
        if saved and len(saved) == n * 4:
            ca.data.foreach_set("color", saved)
        else:
            ca.data.foreach_set("color", array.array('f', [1.0, 1.0, 1.0, 1.0] * n))
        return ca

    # Capture paint values from each canonical name OR its first matching
    # alias. Capture happens BEFORE deletions so values survive the
    # rebuild even when migrating from old layer names.
    captured = {}
    for canon, aliases in LAYER_ALIASES.items():
        for alias in aliases:
            v = _capture_values(alias)
            if v is not None:
                captured[canon] = v
                break

    existing_names = [ca.name for ca in attrs]
    order_ok = (
        len(existing_names) == len(DENSITY_LAYERS)
        and tuple(existing_names) == DENSITY_LAYERS
    )

    if not order_ok:
        # Strip every existing color attribute (we hold their values in
        # `captured` already) and rebuild in canonical order.
        for ca in list(attrs):
            try:
                attrs.remove(ca)
            except (RuntimeError, ReferenceError):
                pass
        for canon in DENSITY_LAYERS:
            _create_solid_white(canon, saved=captured.get(canon))

    # Make grass the active render color by default so Vertex Paint mode
    # opens on it; switch to flowers/colliders via Object Data Properties.
    active = _find(GRASS_LAYER)
    if active is not None:
        try:
            attrs.active_color = active
        except (AttributeError, TypeError):
            pass


class RUBICS_OT_EnsureDensityLayers(bpy.types.Operator):
    """Ensure the active mesh has the three canonical vertex-color layers
    in the right order: grass (COLOR_0), flowers (COLOR_1), colliders
    (COLOR_2). Idempotent — preserves existing paint values, migrates
    legacy names (grass_density / flower_density / Color / Color.001),
    strips any extras.
    """
    bl_idname = "rubics.ensure_density_layers"
    bl_label  = "Ensure Density Layers (grass / flowers / colliders)"
    bl_description = "Lock terrain mesh to three named color attributes: grass, flowers, colliders (COLOR_0..2). Migrates older names; strips extras."
    bl_options = {'REGISTER', 'UNDO'}

    @classmethod
    def poll(cls, context):
        obj = context.active_object
        return obj is not None and obj.type == 'MESH'

    def execute(self, context):
        obj = context.active_object
        if obj is None or obj.type != 'MESH':
            self.report({'ERROR'}, "Select a mesh first (the ground).")
            return {'CANCELLED'}
        name = (obj.name or "").lower()
        if not (name.startswith("ground") or name.startswith("terrain")):
            self.report({'WARNING'}, f"'{obj.name}' is not named ground/terrain — density layers only gate the meadow on the ground mesh.")
        _ensure_density_layers(obj)
        self.report({'INFO'}, f"'{obj.name}' now has {' / '.join(DENSITY_LAYERS)} (COLOR_0..2).")
        return {'FINISHED'}


class RUBICS_OT_AddCollider(bpy.types.Operator):
    """Spawn a 1×1×1 cube collider in the rubics_collider collection.

    Pick the cube, scale/move it around the volume you want to block. On
    export the plugin stamps `rubics_role` on the object so three-js's
    GLTFLoader carries it through to `mesh.userData.rubics_role`. The
    walk-mode loader hides the cube and registers its world AABB.

    Naming convention enforced here: cubes go in as `_col_<n>`. Rename
    them to `_col_<purpose>_<n>` (e.g. `_col_hut_01`) for clarity, or
    prefix with `_col_dyn_` to mark the collider as dynamic (AABB
    recomputed every frame from matrixWorld — needed for cars / NPCs).
    """
    bl_idname = "rubics.add_collider"
    bl_label  = "Add Collider"
    bl_description = "Add an invisible AABB collider cube to the rubics_collider collection"
    bl_options = {'REGISTER', 'UNDO'}

    dynamic: bpy.props.BoolProperty(  # type: ignore[valid-type]
        name="Dynamic",
        description="Stamp the collider as dynamic (AABB updated each frame). Use for moving objects (cars, NPCs).",
        default=False,
    )

    def execute(self, context):
        scene = context.scene
        coll = _ensure_collection(scene, COLLIDER_COLL_NAME)
        # Find the next free numeric suffix.
        prefix = "_col_dyn_" if self.dynamic else "_col_"
        n = 1
        while bpy.data.objects.get(f"{prefix}{n:02d}") is not None:
            n += 1
        name = f"{prefix}{n:02d}"

        import bmesh
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        mesh = bpy.data.meshes.new(f"{name}-mesh")
        bm.to_mesh(mesh)
        bm.free()
        obj = bpy.data.objects.new(name, mesh)
        # Spawn at the 3D cursor, or origin if no cursor placement.
        obj.location = scene.cursor.location.copy()
        # Distinct-from-renderable display so they read as authoring
        # primitives, not actual props. Rendered in viewport (so you can
        # edit them) but excluded from final renders / exports of the .blend.
        obj.display_type = 'WIRE'
        obj.show_in_front = True
        obj.color = (1.0, 0.4, 0.4, 1.0)  # show via solid-mode object color
        obj.hide_render = True
        coll.objects.link(obj)
        # Select for immediate editing.
        for o in context.selected_objects:
            o.select_set(False)
        obj.select_set(True)
        context.view_layer.objects.active = obj

        self.report({'INFO'}, f"Added {'dynamic ' if self.dynamic else ''}collider '{name}' in {COLLIDER_COLL_NAME}.")
        return {'FINISHED'}


class RUBICS_OT_EnsureCollections(bpy.types.Operator):
    """Create rubics_diorama + rubics_collider as direct children of the
    scene root if missing. Idempotent — safe to run anytime; existing
    collections are left untouched.
    """
    bl_idname = "rubics.ensure_collections"
    bl_label  = "Ensure Collections"
    bl_description = f"Create the {DIORAMA_COLL_NAME} and {COLLIDER_COLL_NAME} collections if missing"
    bl_options = {'REGISTER', 'UNDO'}

    def execute(self, context):
        _ensure_collection(context.scene, DIORAMA_COLL_NAME)
        _ensure_collection(context.scene, COLLIDER_COLL_NAME)
        self.report({'INFO'}, f"Collections ready: {DIORAMA_COLL_NAME}, {COLLIDER_COLL_NAME}.")
        return {'FINISHED'}


class RUBICS_OT_Export(bpy.types.Operator):
    bl_idname = "rubics.export_diorama"
    bl_label = "Export Diorama"
    bl_description = "Validate + export current scene to <project>/public/diorama.glb (HMR reloads the app)"
    bl_options = {'REGISTER'}

    def execute(self, context):
        path = _glb_path(context)
        if not path:
            self.report({'ERROR'}, "Set Project Path in addon preferences first")
            return {'CANCELLED'}

        issues = validate_scene(context)
        errors = [m for (lvl, m) in issues if lvl == 'ERROR']
        warnings = [m for (lvl, m) in issues if lvl == 'WARNING']

        if errors:
            for m in errors[:5]:
                self.report({'ERROR'}, m)
            self.report({'ERROR'}, f"{len(errors)} error(s) — aborting export")
            return {'CANCELLED'}

        for m in warnings[:5]:
            self.report({'WARNING'}, m)

        os.makedirs(os.path.dirname(path), exist_ok=True)
        hidden = _isolate_hide_set(context) if context.scene.rubics_isolate_export else set()
        with _with_isolate(context), _with_collider_tags(context):
            bpy.ops.export_scene.gltf(
                filepath=path,
                export_format='GLB',
                export_yup=True,
                export_apply=True,
                export_animations=True,
                export_skins=True,
                export_morph=True,
                export_cameras=False,
                export_lights=False,
                use_visible=True,
                export_extras=True,
            )
        size = os.path.getsize(path) if os.path.exists(path) else 0
        if hidden:
            self.report({'INFO'}, f"Exported {size} bytes → {path} (isolated: {len(hidden)} objects skipped)")
        else:
            self.report({'INFO'}, f"Exported {size} bytes → {path}")
        return {'FINISHED'}


class RUBICS_OT_Validate(bpy.types.Operator):
    bl_idname = "rubics.validate_scene"
    bl_label = "Validate Scene"
    bl_description = "Run pre-flight checks (face-block containment, subdivision, y≥0) without exporting"
    bl_options = {'REGISTER'}

    def execute(self, context):
        issues = validate_scene(context)
        if not issues:
            self.report({'INFO'}, "Scene passes all checks")
            return {'FINISHED'}
        errors = sum(1 for (lvl, _) in issues if lvl == 'ERROR')
        warns = len(issues) - errors
        for lvl, m in issues[:10]:
            self.report({lvl}, m)
        self.report({'INFO'}, f"{errors} error(s), {warns} warning(s)")
        return {'FINISHED'}


class RUBICS_OT_AddGuides(bpy.types.Operator):
    bl_idname = "rubics.add_guides"
    bl_label = "Add Face-Block Guides"
    bl_description = "Create 6 wireframe rectangles marking each face block — visual reference while authoring"
    bl_options = {'REGISTER', 'UNDO'}

    def execute(self, context):
        # Clean up existing guides.
        for obj in list(bpy.data.objects):
            if obj.name.startswith("rubics-guide-"):
                bpy.data.objects.remove(obj, do_unlink=True)

        for name, face, x0, x1, y0, y1 in FACE_BLOCKS:
            # 3D wireframe cage showing the full authoring volume per block:
            # ground rectangle (Z=0) + ceiling rectangle at Z=MAX_HEIGHT
            # (the sphere-projection height cap — props above this clamp)
            # + four vertical edges connecting them. Reads as a translucent
            # "portal region" box so you know when a tree is poking past
            # the ceiling.
            z0, z1 = 0.0, MAX_HEIGHT
            verts = [
                (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),  # ground
                (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1),  # ceiling
            ]
            edges = [
                (0, 1), (1, 2), (2, 3), (3, 0),  # ground rect
                (4, 5), (5, 6), (6, 7), (7, 4),  # ceiling rect
                (0, 4), (1, 5), (2, 6), (3, 7),  # vertical posts
            ]
            mesh = bpy.data.meshes.new(f"rubics-guide-{name}")
            mesh.from_pydata(verts, edges, [])
            mesh.update()
            obj = bpy.data.objects.new(f"rubics-guide-{name}", mesh)
            obj.display_type = 'WIRE'
            obj.hide_select = True
            context.scene.collection.objects.link(obj)

            # Text label at block centre, floating just above the ground rect
            # so it's visible from both orthographic and perspective views.
            # Preserves the face name + cube-normal annotation.
            txt_data = bpy.data.curves.new(name=f"rubics-guide-{name}-label", type='FONT')
            txt_data.body = f"{name} {face}"
            txt_data.size = 0.22
            txt_obj = bpy.data.objects.new(f"rubics-guide-{name}-label", txt_data)
            txt_obj.location = ((x0 + x1) * 0.5 - 0.45, (y0 + y1) * 0.5 - 0.1, 0.01)
            txt_obj.hide_select = True
            context.scene.collection.objects.link(txt_obj)

        self.report({'INFO'}, "Added face-block guides (hidden from selection)")
        return {'FINISHED'}


class RUBICS_OT_LiveToggle(bpy.types.Operator):
    bl_idname = "rubics.live_toggle"
    bl_label = "Live Mode"
    bl_description = ("Auto-export to <project>/public/diorama.glb on every "
                      "scene change (debounced). Vite HMR reloads the app "
                      "so your edits appear at http://localhost:5174/?glb=1 "
                      "within a couple of seconds.")
    bl_options = {'REGISTER'}

    def execute(self, context):
        path = _glb_path(context)
        if not path:
            self.report({'ERROR'}, "Set Project Path in addon preferences first")
            return {'CANCELLED'}
        if _LIVE["enabled"]:
            _live_stop()
            self.report({'INFO'}, "Live mode OFF")
        else:
            _live_start()
            self.report({'INFO'},
                "Live mode ON — edits auto-export to public/diorama.glb. "
                "Visit http://localhost:5174/?glb=1")
        return {'FINISHED'}


class RUBICS_OT_BakeAnimations(bpy.types.Operator):
    bl_idname = "rubics.bake_animations"
    bl_label = "Bake Animations"
    bl_description = (
        "Bake every constraint, driver, and procedural animation on the "
        "selected objects (or all objects if nothing selected) into "
        "explicit keyframes across the scene frame range. Run this when "
        "Live Mode/Export shows static motion in the runtime — drivers "
        "and constraints can't ride through glTF without sampling."
    )
    bl_options = {'REGISTER', 'UNDO'}

    only_selected: bpy.props.BoolProperty(  # type: ignore[valid-type]
        name="Only Selected",
        description="Bake only currently-selected objects. Off → all objects.",
        default=False,
    )

    def execute(self, context):
        scene = context.scene
        objs = list(context.selected_objects) if self.only_selected else [
            o for o in scene.objects if o.type in {'MESH', 'EMPTY', 'ARMATURE'}
        ]
        if not objs:
            self.report({'WARNING'}, "No objects to bake")
            return {'CANCELLED'}
        # Save selection so the user's working state survives the bake.
        prev_active = context.view_layer.objects.active
        prev_sel = [o for o in context.selected_objects]
        for o in context.selected_objects: o.select_set(False)
        baked = 0
        try:
            for obj in objs:
                # Skip objects with neither drivers, constraints, nor animation
                # — bake_action would still write empty keyframes which the
                # exporter then has to filter out.
                anim = obj.animation_data
                has_drivers = bool(anim and anim.drivers and len(anim.drivers))
                has_constraints = bool(obj.constraints and len(obj.constraints))
                has_action = bool(anim and anim.action)
                if not (has_drivers or has_constraints or has_action):
                    continue
                obj.select_set(True)
                context.view_layer.objects.active = obj
                try:
                    bpy.ops.nla.bake(
                        frame_start=int(scene.frame_start),
                        frame_end=int(scene.frame_end),
                        only_selected=True,
                        visual_keying=True,
                        clear_constraints=False,  # keep so re-bake is idempotent
                        clear_parents=False,
                        use_current_action=True,
                        bake_types={'OBJECT', 'POSE'} if obj.type == 'ARMATURE' else {'OBJECT'},
                    )
                    baked += 1
                except Exception as e:
                    print(f"[rubics-bake] {obj.name}: {e}")
                obj.select_set(False)
        finally:
            for o in prev_sel: o.select_set(True)
            context.view_layer.objects.active = prev_active
        self.report({'INFO'}, f"Baked {baked} object(s)")
        return {'FINISHED'}


class RUBICS_OT_RemoveGuides(bpy.types.Operator):
    bl_idname = "rubics.remove_guides"
    bl_label = "Remove Guides"
    bl_description = "Clear the face-block reference wireframes"
    bl_options = {'REGISTER', 'UNDO'}

    def execute(self, context):
        removed = 0
        for obj in list(bpy.data.objects):
            if obj.name.startswith("rubics-guide-"):
                bpy.data.objects.remove(obj, do_unlink=True)
                removed += 1
        self.report({'INFO'}, f"Removed {removed} guide object(s)")
        return {'FINISHED'}


# ── Panel ──────────────────────────────────────────────────────────────────

class RUBICS_PT_Panel(bpy.types.Panel):
    bl_label = "Rubic's World"
    bl_idname = "RUBICS_PT_Panel"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = "Rubic's World"

    def draw(self, context):
        layout = self.layout
        prefs = context.preferences.addons[__name__].preferences

        box = layout.box()
        box.label(text="Project", icon='FILE_FOLDER')
        box.prop(prefs, "project_path", text="")
        path = _glb_path(context)
        if path:
            box.label(text=os.path.relpath(path, bpy.path.abspath(prefs.project_path or "/")))

        layout.separator()
        col = layout.column(align=True)
        col.operator(RUBICS_OT_InitScene.bl_idname, icon='MESH_GRID')
        col.operator(RUBICS_OT_Import.bl_idname,    icon='IMPORT')
        col.operator(RUBICS_OT_Export.bl_idname,    icon='EXPORT')
        col.operator(RUBICS_OT_Validate.bl_idname,  icon='CHECKMARK')
        col.prop(context.scene, "rubics_isolate_export", text="Isolate: only export face-block content")

        layout.separator()
        box = layout.box()
        row = box.row()
        row.label(text="Live mode:", icon='REC' if _LIVE["enabled"] else 'PAUSE')
        row.operator(
            RUBICS_OT_LiveToggle.bl_idname,
            text="ON" if _LIVE["enabled"] else "OFF",
            depress=_LIVE["enabled"],
        )
        if _LIVE["enabled"]:
            if _LIVE["last_export_wall"] > 0:
                ago = max(0, int(time.time() - _LIVE["last_export_wall"]))
                status = "✓" if _LIVE["last_export_ok"] else "✗"
                box.label(text=f"  last export: {ago}s ago {status}")
            else:
                box.label(text="  waiting for first change…")
            box.label(text="http://localhost:5174/?glb=1")
        else:
            box.label(text="Toggle ON to auto-export on change")

        layout.separator()
        col = layout.column(align=True)
        col.label(text="Ground density painting:")
        col.operator(RUBICS_OT_EnsureDensityLayers.bl_idname, icon='GROUP_VCOL')

        layout.separator()
        col = layout.column(align=True)
        col.label(text="Collisions (rubics_collider):")
        col.operator(RUBICS_OT_EnsureCollections.bl_idname, icon='OUTLINER_COLLECTION')
        row = col.row(align=True)
        op_static = row.operator(RUBICS_OT_AddCollider.bl_idname, text="Add Static",  icon='MESH_CUBE')
        op_static.dynamic = False
        op_dynamic = row.operator(RUBICS_OT_AddCollider.bl_idname, text="Add Dynamic", icon='AUTO')
        op_dynamic.dynamic = True

        layout.separator()
        col = layout.column(align=True)
        col.label(text="Animations:")
        col.operator(RUBICS_OT_BakeAnimations.bl_idname, icon='ACTION')

        layout.separator()
        col = layout.column(align=True)
        col.label(text="Reference guides:")
        col.operator(RUBICS_OT_AddGuides.bl_idname,    icon='GRID')
        col.operator(RUBICS_OT_RemoveGuides.bl_idname, icon='X')

        layout.separator()
        box = layout.box()
        box.label(text="Dev server:")
        box.label(text="cd <project> && npm run dev")
        box.label(text="→ http://localhost:5174/?glb=1")


# ── Registration ───────────────────────────────────────────────────────────

CLASSES = [
    RubicsPrefs,
    RUBICS_OT_InitScene,
    RUBICS_OT_Import,
    RUBICS_OT_Export,
    RUBICS_OT_Validate,
    RUBICS_OT_LiveToggle,
    RUBICS_OT_AddGuides,
    RUBICS_OT_RemoveGuides,
    RUBICS_OT_EnsureDensityLayers,
    RUBICS_OT_EnsureCollections,
    RUBICS_OT_AddCollider,
    RUBICS_OT_BakeAnimations,
    RUBICS_PT_Panel,
]


def register():
    for cls in CLASSES:
        bpy.utils.register_class(cls)
    # Scene-scoped so the toggle state persists per-.blend. Default ON per
    # the workflow spec — typical export is "clean, only face-block content".
    bpy.types.Scene.rubics_isolate_export = bpy.props.BoolProperty(
        name="Isolate Export",
        description=(
            "Only export objects whose world XY bounding box overlaps at least "
            "one face-block rectangle. Reference guides (rubics-guide-*) are "
            "always skipped. Off → export every visible object."
        ),
        default=True,
    )


def unregister():
    # Make sure live mode's handler + timer are torn down before classes go
    # away — otherwise Blender holds references to dead operator classes and
    # crashes on the next depsgraph update.
    _live_stop()
    try:
        del bpy.types.Scene.rubics_isolate_export
    except AttributeError:
        pass
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)


if __name__ == "__main__":
    register()

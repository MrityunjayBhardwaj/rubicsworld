bl_info = {
    "name": "Rubic's World",
    "author": "Rubic's World",
    "version": (0, 1, 0),
    "blender": (4, 0, 0),
    "location": "View3D > Sidebar > Rubic's World",
    "description": "Round-trip diorama.glb between Blender and the Rubic's World app",
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
import hashlib
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
        for mod in getattr(obj, "modifiers", []) or []:
            h.update(f"{mod.type}:{mod.name}|".encode())
    for act in sorted(bpy.data.actions, key=lambda a: a.name):
        fs, fe = act.frame_range
        h.update(f"ACT|{act.name}|{fs:.3f}|{fe:.3f}|".encode())
    return h.hexdigest()


def _do_export_current(path: str) -> tuple[bool, int]:
    """Run the glTF exporter with the pipeline flags. Returns (ok, size).
    Safe to call from a timer — doesn't touch the active operator's stack.
    """
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
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
        )
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

        bpy.ops.import_scene.gltf(filepath=path)
        self.report({'INFO'}, f"Imported {path}")
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
        )
        size = os.path.getsize(path) if os.path.exists(path) else 0
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
        col.operator(RUBICS_OT_Import.bl_idname,   icon='IMPORT')
        col.operator(RUBICS_OT_Export.bl_idname,   icon='EXPORT')
        col.operator(RUBICS_OT_Validate.bl_idname, icon='CHECKMARK')

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
    RUBICS_OT_Import,
    RUBICS_OT_Export,
    RUBICS_OT_Validate,
    RUBICS_OT_LiveToggle,
    RUBICS_OT_AddGuides,
    RUBICS_OT_RemoveGuides,
    RUBICS_PT_Panel,
]


def register():
    for cls in CLASSES:
        bpy.utils.register_class(cls)


def unregister():
    # Make sure live mode's handler + timer are torn down before classes go
    # away — otherwise Blender holds references to dead operator classes and
    # crashes on the next depsgraph update.
    _live_stop()
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)


if __name__ == "__main__":
    register()

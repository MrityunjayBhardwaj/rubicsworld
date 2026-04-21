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
import bpy
import mathutils

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


# ── Validation ─────────────────────────────────────────────────────────────

#: object names that are allowed to span the entire cross cube-net without
#: being flagged — these are the continuous ground surfaces that every cell
#: render clips per-face. buildDiorama's own terrain + sphere-terrain use
#: these names.
WHOLE_NET_ALLOWED = {"terrain", "sphere-terrain", "ground"}

#: Small overflow past a row boundary that's OK (per-cell clip planes eat it
#: visually). Anything larger gets elevated to an error.
ROW_OVERFLOW_SOFT = 0.25

#: Below this depth we warn; above is treated as modelling noise.
SUBTERRAIN_NOISE = 0.10


def _name_prefix_allowed(name: str) -> bool:
    base = name.lower().split('.')[0]
    return base in WHOLE_NET_ALLOWED


def _row_overflow(x_min, x_max, y_min, y_max):
    """Return (row_name, overflow) for the best-fitting row.
    Overflow is 0 when the AABB fits; otherwise the max signed distance that
    sticks out of the closest row. Picks the row with the smallest overflow.
    """
    best = ("(outside domain)", float('inf'))
    for name, rx0, rx1, ry0, ry1 in UNFOLD_ROWS:
        ovf = max(
            rx0 - x_min, x_max - rx1,
            ry0 - y_min, y_max - ry1,
            0.0,
        )
        if ovf < best[1]:
            best = (name, ovf)
    return best


def validate_scene(context):
    """Return a list of (level, message) tuples — WARNING / ERROR.

    Blender-native axes: X, Y = ground plane; Z = height. Validator is
    PERMISSIVE — it only hard-errors on clearly broken placements and lets
    the three-js per-cell clip planes handle minor overflows (trees whose
    leaf sphere barely kisses a face-block edge, etc.)
    """
    issues = []
    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue
        if obj.name.startswith("rubics-guide-"):
            continue
        if _name_prefix_allowed(obj.name):
            continue  # Terrain / ground plane — expected to span everything.

        corners = [obj.matrix_world @ mathutils.Vector(c) for c in obj.bound_box]
        xs = [v.x for v in corners]
        ys = [v.y for v in corners]
        zs = [v.z for v in corners]
        x_min, x_max = min(xs), max(xs)
        y_min, y_max = min(ys), max(ys)
        z_min, z_max = min(zs), max(zs)

        # Row containment. Small overflow → warning; deep crossing → error.
        # "Deep" means the mesh's bulk is clearly in two rows, not just its
        # edge poking over.
        row, overflow = _row_overflow(x_min, x_max, y_min, y_max)
        if overflow > ROW_OVERFLOW_SOFT:
            issues.append(('ERROR',
                f"'{obj.name}' crosses cube-net rows by {overflow:.2f} units "
                f"(x={x_min:.2f}..{x_max:.2f}, y={y_min:.2f}..{y_max:.2f}). "
                f"Split it into per-row meshes; rows don't share cube edges."))
        elif overflow > 1e-3:
            issues.append(('WARNING',
                f"'{obj.name}' pokes over a row boundary by {overflow:.2f} units "
                f"— clip planes will handle it, but a tighter fit is safer."))

        # Sub-terrain dip. Ignore the first 10 cm as modelling noise.
        if z_min < -SUBTERRAIN_NOISE:
            issues.append(('WARNING',
                f"'{obj.name}' extends {abs(z_min):.2f} below ground "
                f"(z_min={z_min:.3f}) — will be buried in the planet interior."))

        # vyapti PV1 — long meshes need subdivision for the sphere projection.
        long_axis = max(x_max - x_min, y_max - y_min)
        if long_axis > 1.0:
            mesh = obj.data
            nverts = len(mesh.vertices)
            if nverts < 8 * long_axis:
                issues.append(('WARNING',
                    f"'{obj.name}' spans {long_axis:.1f} flat-units with only "
                    f"{nverts} verts — add loop cuts (≥8 per unit) or it will "
                    f"chord through the sphere."))

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
            # Guides lie flat on Blender's ground plane (XY, Z=0).
            verts = [
                (x0, y0, 0), (x1, y0, 0),
                (x1, y1, 0), (x0, y1, 0),
            ]
            edges = [(0, 1), (1, 2), (2, 3), (3, 0)]
            mesh = bpy.data.meshes.new(f"rubics-guide-{name}")
            mesh.from_pydata(verts, edges, [])
            mesh.update()
            obj = bpy.data.objects.new(f"rubics-guide-{name}", mesh)
            obj.display_type = 'WIRE'
            obj.hide_select = True
            context.scene.collection.objects.link(obj)

            # Text label at block centre, also flat on XY at Z=0.01 so it's
            # readable from the top-down view that authors use while laying
            # out the diorama.
            txt_data = bpy.data.curves.new(name=f"rubics-guide-{name}-label", type='FONT')
            txt_data.body = f"{name} {face}"
            txt_data.size = 0.22
            txt_obj = bpy.data.objects.new(f"rubics-guide-{name}-label", txt_data)
            txt_obj.location = ((x0 + x1) * 0.5 - 0.45, (y0 + y1) * 0.5 - 0.1, 0.01)
            txt_obj.hide_select = True
            context.scene.collection.objects.link(txt_obj)

        self.report({'INFO'}, "Added face-block guides (hidden from selection)")
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
        col = layout.column(align=True)
        col.label(text="Reference guides:")
        col.operator(RUBICS_OT_AddGuides.bl_idname,    icon='GRID')
        col.operator(RUBICS_OT_RemoveGuides.bl_idname, icon='X')

        layout.separator()
        box = layout.box()
        box.label(text="Live preview:")
        box.label(text="npm run dev → visit")
        box.label(text="http://localhost:5174/?glb=1")


# ── Registration ───────────────────────────────────────────────────────────

CLASSES = [
    RubicsPrefs,
    RUBICS_OT_Import,
    RUBICS_OT_Export,
    RUBICS_OT_Validate,
    RUBICS_OT_AddGuides,
    RUBICS_OT_RemoveGuides,
    RUBICS_PT_Panel,
]


def register():
    for cls in CLASSES:
        bpy.utils.register_class(cls)


def unregister():
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)


if __name__ == "__main__":
    register()

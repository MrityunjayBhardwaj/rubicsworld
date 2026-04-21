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

FACE_BLOCKS = [
    # (name, cube face, x_min, x_max, z_min, z_max)
    ("E", "+Z", -2.0,  0.0, -1.0,  1.0),
    ("A", "+X",  0.0,  2.0, -1.0,  1.0),
    ("B", "-X", -4.0, -2.0, -1.0,  1.0),
    ("F", "-Z",  2.0,  4.0, -1.0,  1.0),
    ("C", "+Y", -2.0,  0.0,  1.0,  3.0),
    ("D", "-Y", -2.0,  0.0, -3.0, -1.0),
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

def validate_scene(context):
    """Return a list of (level, message) tuples — WARNING / ERROR."""
    issues = []
    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue
        # World-space bounding box.
        corners = [obj.matrix_world @ mathutils.Vector(c) for c in obj.bound_box]
        xs = [v.x for v in corners]
        zs = [v.z for v in corners]
        ys = [v.y for v in corners]
        x_min, x_max = min(xs), max(xs)
        z_min, z_max = min(zs), max(zs)
        y_min, y_max = min(ys), max(ys)

        in_block = any(
            x_min >= bx0 - 1e-3 and x_max <= bx1 + 1e-3 and
            z_min >= bz0 - 1e-3 and z_max <= bz1 + 1e-3
            for _, _, bx0, bx1, bz0, bz1 in FACE_BLOCKS
        )
        if not in_block:
            issues.append(('ERROR',
                f"'{obj.name}' straddles face-block boundaries "
                f"(x={x_min:.2f}..{x_max:.2f}, z={z_min:.2f}..{z_max:.2f}). "
                f"Move it inside one 2×2 block."))

        if y_min < -0.01:
            issues.append(('WARNING',
                f"'{obj.name}' extends below y=0 (y_min={y_min:.3f}) — "
                f"anything under the terrain gets spherified into the planet."))

        # vyapti PV1: long meshes need enough segments along the long axis.
        # Heuristic: if the mesh is wider than 1 unit along X or Z, it should
        # have ≥8 verts across that dimension.
        long_axis = max(x_max - x_min, z_max - z_min)
        if long_axis > 1.0:
            mesh = obj.data
            nverts = len(mesh.vertices)
            if nverts < 8 * long_axis:
                issues.append(('WARNING',
                    f"'{obj.name}' spans {long_axis:.1f} flat-units but only has "
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

        for name, face, x0, x1, z0, z1 in FACE_BLOCKS:
            verts = [
                (x0, 0, z0), (x1, 0, z0),
                (x1, 0, z1), (x0, 0, z1),
            ]
            edges = [(0, 1), (1, 2), (2, 3), (3, 0)]
            mesh = bpy.data.meshes.new(f"rubics-guide-{name}")
            mesh.from_pydata(verts, edges, [])
            mesh.update()
            obj = bpy.data.objects.new(f"rubics-guide-{name}", mesh)
            obj.display_type = 'WIRE'
            obj.hide_select = True
            context.scene.collection.objects.link(obj)

            # Text label at block centre.
            txt_data = bpy.data.curves.new(name=f"rubics-guide-{name}-label", type='FONT')
            txt_data.body = f"{name} ({face})"
            txt_data.size = 0.25
            txt_obj = bpy.data.objects.new(f"rubics-guide-{name}-label", txt_data)
            txt_obj.location = ((x0 + x1) * 0.5 - 0.4, 0.01, (z0 + z1) * 0.5)
            txt_obj.rotation_euler = (1.5708, 0, 0)  # lay flat on xz plane
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

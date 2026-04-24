"""
Generate a sample flat cube-net .glb directly in Blender — skips the node
GLTFExporter path. Three static cubes (one per +Z/-Z/+Y face block) plus one
keyframe-animated cube that spins around Y over 2 s at 24 fps.

    /Applications/Blender.app/Contents/MacOS/Blender \
        --background --factory-startup --python-exit-code 1 \
        --python scripts/blender-make-sample.py -- <output.glb>

The output is exactly what the app's GLTFExporter path would produce if we
could run it headlessly — same geometry shape, same Y-up convention — and
it's the easiest way to exercise the loader without routing through the
Chromium download dance.
"""

import bpy
import os
import sys


def die(msg: str):
    print(f"[make-sample] FAIL: {msg}")
    sys.exit(1)


def parse_args():
    argv = sys.argv
    if "--" not in argv:
        die("missing `--` separator")
    tail = argv[argv.index("--") + 1:]
    if len(tail) < 1:
        die("usage: blender-make-sample.py -- <output.glb>")
    return tail[0]


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def add_static_cube(name: str, loc, color):
    bpy.ops.mesh.primitive_cube_add(size=0.4, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    mat = bpy.data.materials.new(name=f"{name}-mat")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    obj.data.materials.append(mat)


def add_animated_cube():
    bpy.ops.mesh.primitive_cube_add(size=0.3, location=(-1.0, 0.2, 2.0))
    obj = bpy.context.active_object
    obj.name = "rotating-cube"
    mat = bpy.data.materials.new(name="rotating-cube-mat")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (0.84, 0.69, 0.23, 1.0)
    obj.data.materials.append(mat)

    scn = bpy.context.scene
    scn.frame_start = 1
    scn.frame_end = 48
    scn.render.fps = 24
    obj.rotation_mode = "XYZ"
    for f, rz in ((1, 0.0), (48, 6.28318)):
        scn.frame_set(f)
        obj.rotation_euler[2] = rz
        obj.keyframe_insert(data_path="rotation_euler", index=2, frame=f)
    # Blender 5 moved fcurves onto Action.slots; bezier interpolation is the
    # default and still exports cleanly, so leaving as-is.


def export_glb(path: str):
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_animations=True,
    )
    if not os.path.exists(path):
        die(f"exporter didn't write {path}")
    print(f"[make-sample] wrote {path} ({os.path.getsize(path)} bytes)")


def main():
    out = parse_args()
    clear_scene()
    add_static_cube("box-E", (-1.0, 0.2, 0.0),  (0.25, 0.60, 0.23))  # +Z face
    add_static_cube("box-F", ( 3.0, 0.2, 0.0),  (0.23, 0.37, 0.60))  # -Z face
    add_animated_cube()
    export_glb(out)
    print("[make-sample] OK")


if __name__ == "__main__":
    main()

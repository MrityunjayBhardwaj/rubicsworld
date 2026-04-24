"""
Blender headless round-trip for the diorama .glb exported by the app.

Invocation:
    /Applications/Blender.app/Contents/MacOS/Blender \
        --background --factory-startup --python-exit-code 1 \
        --python scripts/blender-roundtrip.py -- \
        <input.glb> <output.glb> [--add-test-cube]

The script loads `input.glb` into a clean Blender scene, optionally inserts a
test animated cube above the +Z face block so we can verify animations
round-trip into the app, and exports to `output.glb` with the flags the
pipeline needs (+Y up, applied transforms, animations + skinning included).
Exits non-zero on any failure so CI/dev scripts can detect broken files.
"""

import sys
import bpy
import os


def die(msg: str):
    print(f"[blender-roundtrip] FAIL: {msg}")
    sys.exit(1)


def parse_args():
    argv = sys.argv
    if "--" not in argv:
        die("missing `--` separator before script args")
    tail = argv[argv.index("--") + 1:]
    if len(tail) < 2:
        die("usage: blender-roundtrip.py -- <input.glb> <output.glb> [--add-test-cube]")
    add_cube = "--add-test-cube" in tail
    positional = [a for a in tail if not a.startswith("--")]
    return positional[0], positional[1], add_cube


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_glb(path: str):
    if not os.path.exists(path):
        die(f"input not found: {path}")
    bpy.ops.import_scene.gltf(filepath=path)
    n = len(list(bpy.data.objects))
    print(f"[blender-roundtrip] imported {n} objects from {path}")


def add_test_cube():
    # Small cube centred above the +Z face block (flat x=-1, z=0) so it's
    # clearly NOT part of the imported diorama. Keyframe rotate 360° on Z
    # over 48 frames so the app's AnimationMixer has something to play.
    bpy.ops.mesh.primitive_cube_add(size=0.3, location=(-1.0, 0.5, 0.0))
    cube = bpy.context.active_object
    cube.name = "roundtrip-test-cube"
    scn = bpy.context.scene
    scn.frame_start = 1
    scn.frame_end = 48
    cube.rotation_mode = "XYZ"
    for f, rz in ((1, 0.0), (48, 6.28318)):
        scn.frame_set(f)
        cube.rotation_euler[2] = rz
        cube.keyframe_insert(data_path="rotation_euler", index=2, frame=f)
    # Blender 5 moved fcurves off Action onto slots; default interpolation
    # is fine for round-trip verification.
    print("[blender-roundtrip] added animated test cube")


def export_glb(path: str):
    # glTF export flags that match the pipeline contract:
    #   +Y up (three-js convention), apply modifiers / transforms, include
    #   animations + skinning + morph targets so anything the user authors
    #   in Blender travels through to the app intact.
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_animations=True,
        export_skins=True,
        export_morph=True,
        export_cameras=False,
        export_lights=False,
    )
    if not os.path.exists(path):
        die(f"exporter didn't write output: {path}")
    print(f"[blender-roundtrip] exported {path} ({os.path.getsize(path)} bytes)")


def main():
    inp, out, add_cube = parse_args()
    print(f"[blender-roundtrip] in={inp} out={out} add_cube={add_cube}")
    clear_scene()
    import_glb(inp)
    if add_cube:
        add_test_cube()
    export_glb(out)
    print("[blender-roundtrip] OK")


if __name__ == "__main__":
    main()

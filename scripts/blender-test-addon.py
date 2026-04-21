"""
Headless validity check for the Rubic's World Blender addon.

Blender 5.0 headless mode can't reliably invoke bpy.ops.<custom_namespace>
(context limits), but it CAN verify that:
  - The addon module imports cleanly.
  - All bpy.types classes register and unregister without error.
  - The expected operator / panel idnames appear in bpy.ops + bpy.types.
  - The face-block validator runs and catches known bad placements.

The GUI install path — Edit → Preferences → Add-ons → Install — still works
normally; this script exists to guard against regressions in the code that
can be caught without a UI.

Invocation:
    /Applications/Blender.app/Contents/MacOS/Blender \
        --background --factory-startup --python-exit-code 1 \
        --python scripts/blender-test-addon.py -- <project-root>
"""

import sys
import os
import importlib.util

import bpy


def die(msg: str):
    print(f"[addon-test] FAIL: {msg}")
    sys.exit(1)


def main():
    argv = sys.argv
    if "--" not in argv:
        die("missing `--` separator")
    project_root = argv[argv.index("--") + 1]
    addon_src = os.path.join(project_root, "blender-plugin", "rubics_world.py")
    if not os.path.exists(addon_src):
        die(f"addon source not found: {addon_src}")

    # 1. Import the module via spec_from_file_location. Exercises the import
    #    order + any top-level side effects.
    spec = importlib.util.spec_from_file_location("rubics_world", addon_src)
    if not spec or not spec.loader:
        die("couldn't build module spec")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["rubics_world"] = mod
    spec.loader.exec_module(mod)

    if not hasattr(mod, "bl_info"):
        die("addon missing bl_info")
    if not hasattr(mod, "register") or not hasattr(mod, "unregister"):
        die("addon missing register/unregister")
    if "name" not in mod.bl_info:
        die("bl_info missing 'name'")
    print(f"[addon-test] import OK — {mod.bl_info['name']} v{mod.bl_info.get('version', '?')}")

    # 2. Register → verify every class landed in bpy.types / bpy.ops.
    mod.register()
    # Panel should always register; AddonPreferences only shows up when the
    # module is enabled through Blender's addon manager (bl_idname resolution),
    # so we skip checking it from direct-exec.
    expected_types = ["RUBICS_PT_Panel"]
    for name in expected_types:
        if not hasattr(bpy.types, name):
            die(f"bpy.types missing {name}")
    expected_ops = ["import_diorama", "export_diorama", "validate_scene",
                    "add_guides", "remove_guides"]
    rubics_ops = [o for o in dir(bpy.ops.rubics) if not o.startswith("_")]
    for name in expected_ops:
        if name not in rubics_ops:
            die(f"bpy.ops.rubics missing {name} — found {rubics_ops}")
    print(f"[addon-test] register OK — {len(expected_ops)} operators, "
          f"{len(expected_types)} UI classes")

    # 3. Validator sanity — feed a fabricated scene that straddles a face
    #    block and confirm it gets flagged.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.mesh.primitive_cube_add(size=4.0, location=(0.0, 0.2, 0.0))
    bpy.context.active_object.name = "bad-mesh-straddles-boundary"
    issues = mod.validate_scene(bpy.context)
    has_error = any(lvl == 'ERROR' for (lvl, _) in issues)
    if not has_error:
        die(f"validator didn't catch a seam-straddling mesh: {issues}")
    print(f"[addon-test] validator caught {len(issues)} issue(s) — OK")

    # 4. Unregister cleanly.
    mod.unregister()
    for name in expected_types:
        if hasattr(bpy.types, name):
            die(f"unregister left {name} in bpy.types")
    print("[addon-test] unregister OK")

    print("[addon-test] PASS")


if __name__ == "__main__":
    main()

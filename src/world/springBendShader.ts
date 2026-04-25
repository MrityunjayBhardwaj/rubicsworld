import * as THREE from 'three'

/**
 * Spring-bend vertex shader — bends geometry around a SHARED WORLD-SPACE
 * pivot, so a structure made of many meshes (parent groups, rotated
 * children, instanced blades) bends together as a single object.
 *
 * Caller provides four uniforms per "spring object":
 *   uSpringPivotWorld   — world position of the bend pivot (object base)
 *   uSpringUpWorld      — world-space "up" direction of the object
 *                          (axis along which bend ramps from 0 → 1)
 *   uSpringHeightWorld  — full object height in world units
 *   uSpringImpulseWorld — world-space impulse vector (direction + magnitude=angle)
 *
 * Implementation: replaces `<project_vertex>` so it can compute world
 * position, apply the bend, and rebuild `mvPosition` / `gl_Position`.
 * Normals are NOT rotated — lighting on heavily-bent surfaces will be
 * subtly off; acceptable for the prototype. Adding normal rotation
 * would require either rewriting `vNormal` inline (delicate vs.
 * `<normal_vertex>` ordering) or moving the bend math into a chunk
 * before `<defaultnormal_vertex>`, which doesn't have access to
 * `transformed` yet.
 *
 * Idempotent (P31): re-attaching returns existing uniform handles.
 * Chains with prior `onBeforeCompile` (P7).
 *
 * Boundary note: this shader displaces vertices, so any downstream
 * N8AO/SSAO will see normal-reconstruction artefacts (P8). /springy
 * intentionally avoids PostFx for that reason.
 */

export interface SpringBendUniforms {
  uSpringPivotWorld:   { value: THREE.Vector3 }
  uSpringUpWorld:      { value: THREE.Vector3 }
  uSpringHeightWorld:  { value: number }
  uSpringImpulseWorld: { value: THREE.Vector3 }
}

export interface SpringBendOpts {
  uniforms: SpringBendUniforms
}

const VERTEX_DECLS = /* glsl */`
  uniform vec3  uSpringPivotWorld;
  uniform vec3  uSpringUpWorld;
  uniform float uSpringHeightWorld;
  uniform vec3  uSpringImpulseWorld;
`

// Replaces `<project_vertex>`. Mirrors three.js' standard pipeline
// (mvPosition = modelViewMatrix * vec4(transformed, 1.0); gl_Position
// = projectionMatrix * mvPosition) but inserts world-space bend in
// the middle.
const PROJECT_REPLACEMENT = /* glsl */`
  vec4 sLocal = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    sLocal = instanceMatrix * sLocal;
  #endif
  vec4 sWorld = modelMatrix * sLocal;

  // World-space spring bend.
  vec3 sUp = normalize(uSpringUpWorld);
  float sH = clamp(dot(sWorld.xyz - uSpringPivotWorld, sUp) / max(uSpringHeightWorld, 1e-4), 0.0, 1.0);
  sH = sH * sH;
  vec3 sAxis = cross(sUp, uSpringImpulseWorld);
  float sLen = length(sAxis);
  float sMag = length(uSpringImpulseWorld);
  if (sLen > 1e-5 && sH > 0.0 && sMag > 1e-5) {
    sAxis /= sLen;
    float sAng = sH * sMag;
    float sC = cos(sAng);
    float sS = sin(sAng);
    vec3 sV = sWorld.xyz - uSpringPivotWorld;
    sWorld.xyz = uSpringPivotWorld
      + sV * sC
      + cross(sAxis, sV) * sS
      + sAxis * dot(sAxis, sV) * (1.0 - sC);
  }

  vec4 mvPosition = viewMatrix * sWorld;
  gl_Position = projectionMatrix * mvPosition;
`

export function attachSpringBend(material: THREE.Material, opts: SpringBendOpts): SpringBendUniforms {
  if (material.userData.springAttached) {
    return material.userData.springUniforms as SpringBendUniforms
  }
  material.userData.springAttached = true
  material.userData.springUniforms = opts.uniforms

  const prev = material.onBeforeCompile?.bind(material)
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer)
    shader.uniforms.uSpringPivotWorld   = opts.uniforms.uSpringPivotWorld
    shader.uniforms.uSpringUpWorld      = opts.uniforms.uSpringUpWorld
    shader.uniforms.uSpringHeightWorld  = opts.uniforms.uSpringHeightWorld
    shader.uniforms.uSpringImpulseWorld = opts.uniforms.uSpringImpulseWorld

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',          '#include <common>\n' + VERTEX_DECLS)
      .replace('#include <project_vertex>',  PROJECT_REPLACEMENT)
  }
  material.needsUpdate = true
  return opts.uniforms
}

/** Build a fresh set of spring uniforms — one per "spring object" (e.g. one windmill). */
export function makeSpringUniforms(): SpringBendUniforms {
  return {
    uSpringPivotWorld:   { value: new THREE.Vector3() },
    uSpringUpWorld:      { value: new THREE.Vector3(0, 1, 0) },
    uSpringHeightWorld:  { value: 1.0 },
    uSpringImpulseWorld: { value: new THREE.Vector3() },
  }
}

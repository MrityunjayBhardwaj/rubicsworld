/**
 * Imperative diorama builder on the cross cube-net layout.
 *
 * Bounding box: 8 × 6 cells (cross net). Only 24 cells are "filled" —
 * the rest is empty padding in the flat view but unreachable during
 * sphere/cube rendering (each face-block maps to one cube face).
 *
 * Face-block local extents in (x, z):
 *   E (+Z center):      x ∈ [-2,  0], z ∈ [-1,  1]
 *   A (+X right):       x ∈ [ 0,  2], z ∈ [-1,  1]
 *   B (-X left):        x ∈ [-4, -2], z ∈ [-1,  1]
 *   F (-Z far right):   x ∈ [ 2,  4], z ∈ [-1,  1]
 *   C (+Y top):         x ∈ [-2,  0], z ∈ [ 1,  3]
 *   D (-Y bottom):      x ∈ [-2,  0], z ∈ [-3, -1]
 *
 * Every object is placed strictly inside one face-block, so nothing
 * gets cut across a flat-adjacent seam that would land on a mismatched
 * cube edge.
 */

import * as THREE from 'three'
import { buildGrass } from './buildGrass'

export const BASE_W = 8
export const BASE_H = 6
export const HALF_W = BASE_W / 2  // 4
export const HALF_H = BASE_H / 2  // 3

// ── helpers ──────────────────────────────────────────────────────────

/** MSM factory with PBR-correct defaults: dielectric (metalness 0) unless
 *  the caller explicitly sets metalness. Keeps DoubleSide for low-poly
 *  geometry that uses a single plane for both faces. */
function mat(opts: THREE.MeshStandardMaterialParameters) {
  return new THREE.MeshStandardMaterial({
    side: THREE.DoubleSide,
    metalness: 0,
    roughness: 0.85,
    ...opts,
  })
}

/** Shared uniform driving the "Fresnel on/off" toggle. Updated per-frame
 *  from the HDRI store; read by every patched diorama MSM. 1 = full
 *  specular IBL (physical Fresnel rim), 0 = rim suppressed (diffuse only). */
export const fresnelUniform: { value: number } = { value: 1 }

/** Active slice-rotation state, shared with the global sphere terrain's
 *  triplanar shader. When a slice is rotating, fragments inside that slice
 *  (positive `along × sign` half-space) sample the terrain texture from the
 *  PRE-rotation position — the texture appears painted onto the rotating
 *  tiles instead of staying anchored to world coords beneath them.
 *
 *  uTileOriInv[24]: per-tile inverse orientation quaternion, indexed by
 *  CURRENT cube position (face*4 + v*2 + u). The shader determines which
 *  tile owns each fragment from world position, then applies that tile's
 *  inverse rotation to the sampling coords. Texture appears permanently
 *  painted onto each tile across rotation commits (not just mid-animation). */
const TILE_COUNT = 24
// Flat Float32Array of 24 × 4 quaternion components — three.js's uniform
// upload path for `vec4[N]` is more reliable with a flat typed array than
// with an array of Vector4 instances (the latter sometimes wasn't actually
// uploading updated values, which is what kept the terrain texture from
// following tile rotations). Layout: [q0.x, q0.y, q0.z, q0.w, q1.x, ...].
const _oriInvFlat = new Float32Array(TILE_COUNT * 4)
for (let i = 0; i < TILE_COUNT; i++) _oriInvFlat[i * 4 + 3] = 1  // w=1 → identity
export const sliceRotUniforms = {
  uSliceAxis:   { value: new THREE.Vector3(1, 0, 0) },
  uSliceAngle:  { value: 0 },
  uSliceSign:   { value: 1 },
  uSliceActive: { value: 0 },
  uTileOriInv:  { value: _oriInvFlat },
}

/** Polka-dot HUD overlay uniforms, rendered by the global terrain's triplanar
 *  fragment shader on top of the grass.
 *
 *  - uHudOpacity: global attract fade. 1.0 at t=0 (entire planet shows dots),
 *    animated to 0.0 after first player commit — then only cursor reveals.
 *  - uHudCursor: world-space cursor position, published by Interaction.tsx
 *    on raycast hits.
 *  - uHudCursorActive: 1.0 when cursor is on planet, 0.0 otherwise.
 *  - uHudHoverRadius: world-space sigma of the gaussian cursor-proximity
 *    falloff. 0.35 ≈ one-third of a cube face.
 *  - uHudTileEdgeMask[96]: per-edge mask for L3 easy-mode correctness colors.
 *    Layout: tileIdx * 4 + edgeIdx, where edge order is +right / -right /
 *    +up / -up in face-local coords. 0 = correct neighbor, 1 = wrong.
 *    All zeros in L2 (no-op); L3 wires it. */
const _hudEdgeMaskFlat = new Float32Array(TILE_COUNT * 4)  // all zeros
export const hudUniforms = {
  uHudOpacity:       { value: 1.0 },
  uHudCursor:        { value: new THREE.Vector3(0, 0, 0) },
  uHudCursorActive:  { value: 0.0 },
  uHudHoverRadius:   { value: 0.35 },
  uHudTileEdgeMask:  { value: _hudEdgeMaskFlat },
  uHudEasyMode:      { value: 0.0 },   // 0 = monochrome dots, 1 = green/red
}

/** Compose-safe fragment-shader patch that scales the indirect-specular
 *  radiance by uFresnelScale. Preserves any existing onBeforeCompile so
 *  it stacks with TileGrid's sphere-projection vertex patch.
 *  Idempotent: if a material is shared across multiple meshes (e.g. the
 *  starling flock shares one material across all 10 birds × 3 parts), the
 *  scene traversal calls this repeatedly on the same material — without
 *  this guard every re-patch would stack another `uniform float
 *  uFresnelScale;` after `#include <common>`, producing a duplicate-
 *  declaration shader compile error → silent invisibility. */
function patchMaterialForFresnel(material: THREE.Material) {
  const ud = material.userData as { __fresnelPatched?: boolean }
  if (ud.__fresnelPatched) return
  ud.__fresnelPatched = true
  const prevOBC = material.onBeforeCompile
  const prevKey = material.customProgramCacheKey
  material.onBeforeCompile = (shader, renderer) => {
    prevOBC?.call(material, shader, renderer)
    shader.uniforms.uFresnelScale = fresnelUniform
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uFresnelScale;`,
      )
      .replace(
        '#include <lights_fragment_maps>',
        `#include <lights_fragment_maps>
         #if defined(USE_ENVMAP) && defined(RE_IndirectSpecular)
           radiance *= uFresnelScale;
           #ifdef USE_CLEARCOAT
             clearcoatRadiance *= uFresnelScale;
           #endif
         #endif`,
      )
  }
  material.customProgramCacheKey = () => (prevKey?.call(material) ?? '') + '|fresnel'
  material.needsUpdate = true
}

/** Triplanar texture sampling — projects world position onto each major
 *  axis, samples the texture three times, blends by absolute world-normal
 *  weights. Used on the global SphereGeometry terrain to map a tileable
 *  texture without pole pinching (which spherical UVs would produce).
 *  Density chosen to match the per-tile flat terrain (1 full texture repeat
 *  per 2-unit face block at UV_DENSITY = 0.5). */
function patchMaterialForTriplanar(material: THREE.Material, texture: THREE.Texture) {
  const ud = material.userData as { __triplanarPatched?: boolean }
  if (ud.__triplanarPatched) return
  ud.__triplanarPatched = true
  const prevOBC = material.onBeforeCompile
  const prevKey = material.customProgramCacheKey
  material.onBeforeCompile = (shader, renderer) => {
    prevOBC?.call(material, shader, renderer)
    shader.uniforms.uTriplanarMap = { value: texture }
    shader.uniforms.uTriplanarScale = { value: 0.5 }
    // Slice-rotation hook (see sliceRotUniforms): bind the same Vector3 etc.
    // so TileGrid.useFrame's per-frame writes are visible here.
    shader.uniforms.uSliceAxis = sliceRotUniforms.uSliceAxis
    shader.uniforms.uSliceAngle = sliceRotUniforms.uSliceAngle
    shader.uniforms.uSliceSign = sliceRotUniforms.uSliceSign
    shader.uniforms.uSliceActive = sliceRotUniforms.uSliceActive
    shader.uniforms.uTileOriInv = sliceRotUniforms.uTileOriInv
    // HUD overlay (dot pattern + cursor reveal + correctness colors)
    shader.uniforms.uHudOpacity = hudUniforms.uHudOpacity
    shader.uniforms.uHudCursor = hudUniforms.uHudCursor
    shader.uniforms.uHudCursorActive = hudUniforms.uHudCursorActive
    shader.uniforms.uHudHoverRadius = hudUniforms.uHudHoverRadius
    shader.uniforms.uHudTileEdgeMask = hudUniforms.uHudTileEdgeMask
    shader.uniforms.uHudEasyMode = hudUniforms.uHudEasyMode

    // Vertex: forward world-space position + normal to fragment.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
       varying vec3 vTriWorldPos;
       varying vec3 vTriWorldNormal;`,
    ).replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
       vTriWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
       vTriWorldNormal = normalize(mat3(modelMatrix) * objectNormal);`,
    )

    // Fragment: replace <map_fragment> with triplanar sampling so the
    // material's diffuseColor is modulated by the texture exactly the same
    // way three.js's USE_MAP path would have done. Plus a Rodrigues
    // inverse-rotation when the fragment lies in the actively-rotating slice.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
       uniform sampler2D uTriplanarMap;
       uniform float uTriplanarScale;
       uniform vec3  uSliceAxis;
       uniform float uSliceAngle;
       uniform float uSliceSign;
       uniform float uSliceActive;
       uniform vec4  uTileOriInv[24];
       uniform float uHudOpacity;
       uniform vec3  uHudCursor;
       uniform float uHudCursorActive;
       uniform float uHudHoverRadius;
       uniform vec4  uHudTileEdgeMask[24];   // xyzw = +right, -right, +up, -up edge flags
       uniform float uHudEasyMode;
       varying vec3 vTriWorldPos;
       varying vec3 vTriWorldNormal;
       vec3 rotateAxisAngle(vec3 p, vec3 axis, float ang) {
         float c = cos(ang);
         float s = sin(ang);
         return p * c + cross(axis, p) * s + axis * dot(axis, p) * (1.0 - c);
       }
       // Quaternion-rotate a vector. q.xyz = axis*sin(ang/2), q.w = cos(ang/2).
       vec3 applyQuat(vec4 q, vec3 v) {
         vec3 t = 2.0 * cross(q.xyz, v);
         return v + q.w * t + cross(q.xyz, t);
       }
       // Determine cube tile index (0..23) at world position P. Faces:
       //   0 +X  1 -X  2 +Y  3 -Y  4 +Z  5 -Z
       // (face,u,v) tile index = face*4 + v*2 + u. u,v ∈ {0,1} from sign of
       // dot with that face's right/up vectors. Must match faces.ts.
       int computeTileIdx(vec3 P) {
         vec3 absP = abs(P);
         int face;
         vec3 fRight, fUp;
         if (absP.x >= absP.y && absP.x >= absP.z) {
           if (P.x > 0.0) { face = 0; fRight = vec3(0.0, 0.0,-1.0); fUp = vec3(0.0, 1.0, 0.0); }
           else           { face = 1; fRight = vec3(0.0, 0.0, 1.0); fUp = vec3(0.0, 1.0, 0.0); }
         } else if (absP.y >= absP.z) {
           if (P.y > 0.0) { face = 2; fRight = vec3(1.0, 0.0, 0.0); fUp = vec3(0.0, 0.0,-1.0); }
           else           { face = 3; fRight = vec3(1.0, 0.0, 0.0); fUp = vec3(0.0, 0.0, 1.0); }
         } else {
           if (P.z > 0.0) { face = 4; fRight = vec3(1.0, 0.0, 0.0); fUp = vec3(0.0, 1.0, 0.0); }
           else           { face = 5; fRight = vec3(-1.0, 0.0, 0.0); fUp = vec3(0.0, 1.0, 0.0); }
         }
         // tile.u: 0 = −right side, 1 = +right side (uOff = (u-0.5)*CELL)
         // tile.v: 0 = +up    side, 1 = −up    side (vOff = (0.5-v)*CELL — inverted)
         int u = (dot(P, fRight) > 0.0) ? 1 : 0;
         int v = (dot(P, fUp)    > 0.0) ? 0 : 1;
         return face * 4 + v * 2 + u;
       }`,
    ).replace(
      '#include <map_fragment>',
      `// Two-stage inverse rotation so the texture stays painted onto each
       // tile across both in-progress slice rotations AND committed history:
       //   1. Active slice rotation (mid-animation): undo it on in-slice
       //      fragments to land in the pre-rotation cube frame, where the
       //      tile's stored .face/.u/.v still point at the correct tile.
       //   2. Per-tile cumulative orientation: every commit absorbs the
       //      rotation into tile.orientation. Look up the tile owning this
       //      cube cell and apply its inverse so we sample at the SOLVED
       //      texture position. Position+normal rotated together so triplanar
       //      blend weights track the rotation (no axis-band stretching).
       vec3 worldP = vTriWorldPos;
       vec3 worldN = normalize(vTriWorldNormal);
       if (uSliceActive > 0.5) {
         float along = dot(worldP, uSliceAxis);
         if (along * uSliceSign > 0.0) {
           worldP = rotateAxisAngle(worldP, uSliceAxis, -uSliceAngle);
           worldN = rotateAxisAngle(worldN, uSliceAxis, -uSliceAngle);
         }
       }
       int tileIdx = computeTileIdx(worldP);
       // Save post-slice-unwind, pre-orientation-unwind worldP for HUD.
       // HUD dots anchor to the visible TILE's local frame (post-slice)
       // but not to the tile's solved-state orientation (pre-ori) — this
       // way dots sit on the tile as it rotates, same as the grass texture.
       vec3 hudWorldP = worldP;
       vec4 oriInv = uTileOriInv[tileIdx];
       worldP = applyQuat(oriInv, worldP);
       worldN = applyQuat(oriInv, worldN);
       vec3 triW = pow(abs(worldN), vec3(4.0));
       triW /= max(triW.x + triW.y + triW.z, 0.0001);
       vec3 p = worldP * uTriplanarScale;
       vec4 triX = texture2D(uTriplanarMap, p.zy);
       vec4 triY = texture2D(uTriplanarMap, p.xz);
       vec4 triZ = texture2D(uTriplanarMap, p.xy);
       vec4 triCol = triX * triW.x + triY * triW.y + triZ * triW.z;
       diffuseColor *= triCol;

       // ── HUD overlay: tile edge lines ───────────────────────────
       // Two line thicknesses distinguish the two kinds of tile edge on a
       // 2×2 puzzle:
       //   • THIN — cube face-boundary edges between tiles on adjacent
       //     faces. These tiles belong to the SAME corner cubie and always
       //     rotate together; the edge is a within-piece seam, cosmetic.
       //   • THICK — face-internal mid-face seams. These cut between two
       //     different cubies on the same face; any axis rotation shears
       //     across this seam. These are the slice boundaries — the
       //     "rotatable tile group" edges the player cares about.
       // Global uHudOpacity drives attract mode (whole planet lit at t=0);
       // cursor proximity gives a localized reveal after attract fades.
       {
         // Re-derive face basis for hudWorldP (the tile's visible cube cell).
         vec3 absP = abs(hudWorldP);
         vec3 fRight, fUp;
         if (absP.x >= absP.y && absP.x >= absP.z) {
           if (hudWorldP.x > 0.0) { fRight = vec3(0.0, 0.0,-1.0); fUp = vec3(0.0, 1.0, 0.0); }
           else                    { fRight = vec3(0.0, 0.0, 1.0); fUp = vec3(0.0, 1.0, 0.0); }
         } else if (absP.y >= absP.z) {
           if (hudWorldP.y > 0.0) { fRight = vec3(1.0, 0.0, 0.0); fUp = vec3(0.0, 0.0,-1.0); }
           else                    { fRight = vec3(1.0, 0.0, 0.0); fUp = vec3(0.0, 0.0, 1.0); }
         } else {
           if (hudWorldP.z > 0.0) { fRight = vec3(1.0, 0.0, 0.0); fUp = vec3(0.0, 1.0, 0.0); }
           else                    { fRight = vec3(-1.0,0.0, 0.0); fUp = vec3(0.0, 1.0, 0.0); }
         }
         float dotR = dot(hudWorldP, fRight);
         float dotU = dot(hudWorldP, fUp);
         int tU = (dotR > 0.0) ? 1 : 0;
         int tV = (dotU > 0.0) ? 0 : 1;
         // Tile-local UV ∈ [-0.5, 0.5] along face.right and face.up.
         float uL = dotR - (float(tU) - 0.5);
         float vL = dotU - (0.5 - float(tV));

         float edgeDistU = 0.5 - abs(uL);
         float edgeDistV = 0.5 - abs(vL);
         float edgeDist;
         bool internalEdge;
         if (edgeDistU < edgeDistV) {
           edgeDist = edgeDistU;
           // +right edge (uL>0) is internal iff tU==0 (neighbor u=1 same face);
           // -right edge (uL<0) is internal iff tU==1.
           internalEdge = (uL > 0.0) ? (tU == 0) : (tU == 1);
         } else {
           edgeDist = edgeDistV;
           // +up edge (vL>0) is internal iff tV==1 (neighbor v=0 same face);
           // -up edge (vL<0) is internal iff tV==0.
           internalEdge = (vL > 0.0) ? (tV == 1) : (tV == 0);
         }

         // Line half-widths in tile-local units. Face-boundary lines are
         // rendered from BOTH adjacent tiles (each draws its half), so the
         // per-side width is roughly half the visible stroke.
         float thinHW  = 0.012;
         float thickHW = 0.028;
         float hw = internalEdge ? thickHW : thinHW;

         // Suppress at 3-face cube corners: fragments near the corner of a
         // face (both edgeDistU and edgeDistV small) classify ambiguously
         // because the max-abs-component face picker flickers between three
         // candidate faces → visible speckle. Fade the line out where the
         // "non-nearest" edge distance is also small.
         float otherEdgeDist = (edgeDistU < edgeDistV) ? edgeDistV : edgeDistU;
         float cornerFade = smoothstep(0.015, 0.06, otherEdgeDist);

         // Cursor proximity in world space — vTriWorldPos (pre-slice-unwind)
         // so the revealed region doesn't shift as a slice animates.
         float cd = distance(vTriWorldPos, uHudCursor);
         float cursorW = uHudCursorActive * exp(-(cd*cd) / (uHudHoverRadius*uHudHoverRadius));
         float reveal = max(uHudOpacity, cursorW);

         // Line alpha — soft inner edge so the stroke reads as an aliased line.
         float lineAlpha = (1.0 - smoothstep(hw * 0.55, hw, edgeDist)) * reveal * cornerFade;

         // Easy-mode tint (L3): sample the per-edge mask to tint the line
         // green where both tiles are at home across this edge, red where not.
         // Off in L3-disabled mode (uHudEasyMode eases to 0) → pure yellow.
         vec4 mask = uHudTileEdgeMask[tileIdx];
         float maskVal;
         if (edgeDistU < edgeDistV) {
           maskVal = (uL > 0.0) ? mask.x : mask.y;
         } else {
           maskVal = (vL > 0.0) ? mask.z : mask.w;
         }
         vec3 yellow = vec3(1.00, 0.88, 0.25);
         vec3 easyCol = mix(vec3(0.50, 0.95, 0.45), vec3(0.98, 0.45, 0.35), maskVal);
         vec3 lineColor = mix(yellow, easyCol, uHudEasyMode);

         diffuseColor.rgb = mix(diffuseColor.rgb, lineColor, lineAlpha);
       }`,
    )
  }
  material.customProgramCacheKey = () => (prevKey?.call(material) ?? '') + '|triplanar'
  material.needsUpdate = true
}

function applyFresnelPatchToScene(root: THREE.Object3D) {
  root.traverse(child => {
    const m = (child as THREE.Mesh).material
    if (!m) return
    const mats = Array.isArray(m) ? m : [m]
    for (const mm of mats) {
      if ((mm as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
        patchMaterialForFresnel(mm)
      }
    }
  })
}

/** Cross-net membership test (keeps the terrain / fills in the net shape). */
function onNet(x: number, z: number): boolean {
  // Middle band: x ∈ [-4, 4], z ∈ [-1, 1]
  if (z >= -1 && z <= 1) return x >= -4 && x <= 4
  // C (top) or D (bottom) stems: x ∈ [-2, 0]
  if (x >= -2 && x <= 0) return z >= -3 && z <= 3
  return false
}

// ── terrain ──────────────────────────────────────────────────────────

const TERRAIN_GREEN = '#9ec280'  // brighter base — multiplies with grass map

// Seamless CC0 grass (polyhaven `aerial_grass_rock`, 1K JPG). Module-scoped
// cache — one GPU upload shared between the per-tile flat terrain and the
// global sphere terrain.
let _grassTex: THREE.Texture | null = null
function grassTexture(): THREE.Texture {
  if (_grassTex) return _grassTex
  const tex = new THREE.TextureLoader().load('/textures/grass_diff_1k.jpg')
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  _grassTex = tex
  return tex
}

function buildTerrain(): THREE.Mesh {
  const segX = 64
  const segZ = 48
  const g = new THREE.PlaneGeometry(BASE_W, BASE_H, segX, segZ)
  g.rotateX(-Math.PI / 2)

  const pos = g.attributes.position
  const uv = g.attributes.uv
  const colors = new Float32Array(pos.count * 3)

  // World-space UVs at 0.5 rep/unit → one full grass repeat per 2-unit face
  // block. Cross-net layout makes flat-adjacent = cube-adjacent so the
  // tileable texture flows continuously across every cube face seam.
  const UV_DENSITY = 0.5

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    pos.setY(i, 0)
    uv.setXY(i, x * UV_DENSITY, z * UV_DENSITY)

    // Vertex colour dims padding cells so the cross shape reads in flat/grid
    // view. Playable cells stay at full material colour (1.0), padding 0.35.
    const dim = onNet(x, z) ? 1 : 0.35
    colors[i * 3]     = dim
    colors[i * 3 + 1] = dim
    colors[i * 3 + 2] = dim
  }

  uv.needsUpdate = true
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  g.computeVertexNormals()

  const m = new THREE.Mesh(g, mat({
    color: TERRAIN_GREEN,
    map: grassTexture(),
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
  }))
  m.receiveShadow = true
  m.name = 'terrain'
  return m
}

// ── water (animated) ─────────────────────────────────────────────────

function buildPond(cx: number, cz: number, radius: number, name: string) {
  const seg = 32
  const g = new THREE.PlaneGeometry(radius * 2, radius * 2, seg, seg)
  g.rotateX(-Math.PI / 2)
  const pos = g.attributes.position
  const origY = new Float32Array(pos.count)
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    const dist = Math.sqrt(x * x + z * z)
    if (dist > radius) {
      const scale = radius / dist
      pos.setX(i, x * scale)
      pos.setZ(i, z * scale)
    }
  }
  pos.needsUpdate = true
  const m = new THREE.Mesh(
    g,
    // Water is a smooth dielectric — low roughness, metalness 0. The 0.3
    // metalness we had before was physically wrong (pure water is not a
    // conductor) and tinted reflections unnaturally.
    mat({ color: '#3a7db8', transparent: true, opacity: 0.8, roughness: 0.05, metalness: 0 }),
  )
  m.position.set(cx, 0.05, cz)
  m.receiveShadow = true
  m.name = name

  const update = (t: number) => {
    const pos = g.attributes.position
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      pos.setY(i, origY[i] + Math.sin(x * 8 + t * 2.5) * 0.008 + Math.cos(z * 6 + t * 1.8) * 0.006)
    }
    pos.needsUpdate = true
  }

  return { mesh: m, update }
}

// ── hut ──────────────────────────────────────────────────────────────

function buildHut(px: number, pz: number): THREE.Group {
  const g = new THREE.Group()
  g.position.set(px, 0, pz)
  g.name = 'hut'

  const walls = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.4, 0.44), mat({ color: '#c4a67a', roughness: 0.9 }))
  walls.position.set(0, 0.2, 0); walls.castShadow = true; walls.receiveShadow = true
  g.add(walls)

  const roof = new THREE.Mesh(new THREE.ConeGeometry(0.44, 0.28, 4), mat({ color: '#8b4a2a', roughness: 0.8 }))
  roof.position.set(0, 0.52, 0); roof.rotation.y = Math.PI / 4; roof.castShadow = true
  g.add(roof)

  const door = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.2, 0.02), mat({ color: '#5a3a1a', roughness: 0.8 }))
  door.position.set(0, 0.12, 0.224)
  g.add(door)

  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.08), mat({ color: '#7a6a5a', roughness: 0.9 }))
  chimney.position.set(0.16, 0.6, -0.08); chimney.castShadow = true
  g.add(chimney)

  return g
}

// ── windmill (animated) ──────────────────────────────────────────────

function buildWindmill(px: number, pz: number) {
  const g = new THREE.Group()
  g.position.set(px, 0, pz)
  g.name = 'windmill'

  const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.8, 8), mat({ color: '#9a9080', roughness: 0.9 }))
  tower.position.set(0, 0.4, 0); tower.castShadow = true
  g.add(tower)

  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.12, 8), mat({ color: '#6a5a4a', roughness: 0.85 }))
  cap.position.set(0, 0.84, 0); cap.castShadow = true
  g.add(cap)

  const blades = new THREE.Group()
  blades.position.set(0, 0.7, 0.14)
  for (let i = 0; i < 4; i++) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.44, 0.01), mat({ color: '#d4c8a0', roughness: 0.7 }))
    blade.rotation.z = (i * Math.PI) / 2
    blade.castShadow = true
    blades.add(blade)
  }
  g.add(blades)

  const update = (t: number) => { blades.rotation.z = t * 0.8 }

  return { group: g, update }
}

// ── trees (animated sway) ────────────────────────────────────────────

// Trees inside face-blocks only. Each tree sits strictly within one block
// so no tree mesh straddles a flat seam (which would fold poorly).
const TREE_POSITIONS: [number, number, number][] = [
  // E block  (x ∈ [-2, 0], z ∈ [-1, 1])
  [-1.7,  0, -0.7],
  [-0.3,  0,  0.7],
  // A block  (x ∈ [0, 2], z ∈ [-1, 1])
  [ 0.3,  0, -0.7],
  [ 1.8,  0,  0.6],
  // B block  (x ∈ [-4, -2], z ∈ [-1, 1])
  [-2.3,  0,  0.5],
  [-3.5,  0, -0.5],
  [-2.9,  0,  0.8],
  // F block  (x ∈ [2, 4], z ∈ [-1, 1])
  [ 2.3,  0, -0.6],
  [ 3.6,  0,  0.4],
  // C block  (x ∈ [-2, 0], z ∈ [1, 3])  — top face
  [-1.6,  0,  1.4],
  [-0.4,  0,  2.4],
  // D block  (x ∈ [-2, 0], z ∈ [-3, -1])  — bottom face
  [-0.6,  0, -1.5],
  [-1.7,  0, -2.4],
]
const TREE_SCALES = [
  1.0, 0.85,   // E
  0.9, 1.05,   // A
  0.75, 0.65, 0.9, // B
  0.8, 0.95,   // F
  0.7, 0.8,    // C
  1.0, 0.75,   // D
]

function buildTrees() {
  const root = new THREE.Group()
  root.name = 'trees'
  const swayGroups: { g: THREE.Group; phase: number }[] = []

  for (let i = 0; i < TREE_POSITIONS.length; i++) {
    const pos = TREE_POSITIONS[i]
    const s = TREE_SCALES[i]
    const phase = i * 2.1

    const tree = new THREE.Group()
    tree.position.set(...pos)

    const swayG = new THREE.Group()
    const trunkH = 0.36 * s
    const canopyR = 0.2 * s

    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03 * s, 0.05 * s, trunkH, 6),
      mat({ color: '#6b4c30', roughness: 0.9 }),
    )
    trunk.position.y = trunkH / 2; trunk.castShadow = true
    swayG.add(trunk)

    const canopy = new THREE.Mesh(
      new THREE.IcosahedronGeometry(canopyR, 1),
      mat({ color: s > 0.9 ? '#3a7a3a' : '#4a8a3a', roughness: 0.8 }),
    )
    canopy.position.y = trunkH + canopyR * 0.6; canopy.castShadow = true
    swayG.add(canopy)

    tree.add(swayG)
    root.add(tree)
    swayGroups.push({ g: swayG, phase })
  }

  const update = (t: number) => {
    for (const { g, phase } of swayGroups) {
      g.rotation.z = Math.sin(t * 1.2 + phase) * 0.03
      g.rotation.x = Math.cos(t * 0.9 + phase * 1.3) * 0.02
    }
  }

  return { group: root, update }
}

// ── fence ────────────────────────────────────────────────────────────

function buildFence(): THREE.Group {
  // Inside E block only. Cosmetic front-yard boundary.
  const g = new THREE.Group()
  g.name = 'fence'
  for (let i = 0; i < 5; i++) {
    const t = i / 4
    const post = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.12, 0.03),
      mat({ color: '#7a6040', roughness: 0.9 }),
    )
    post.position.set(
      THREE.MathUtils.lerp(-1.6, -0.4, t),
      0.06,
      THREE.MathUtils.lerp(0.7, 0.9, t),
    )
    post.castShadow = true
    g.add(post)
  }
  return g
}

// ── flowers ──────────────────────────────────────────────────────────

function buildFlowers(): THREE.Group {
  const g = new THREE.Group()
  g.name = 'flowers'
  const colors = ['#e85a7a', '#e8c85a', '#fff', '#d07ae8', '#e8a05a']
  let ci = 0

  // Flowers within face blocks. Positions hand-picked so each block has a few.
  const spots: [number, number][] = [
    // E block
    [-0.5, -0.2], [-1.3, -0.5], [-0.8, 0.4],
    // A block
    [ 0.6,  0.3], [ 1.4, -0.5], [ 0.8, -0.2],
    // B block
    [-2.4, -0.3], [-3.1,  0.2], [-3.6, -0.7],
    // F block
    [ 2.5,  0.2], [ 3.2, -0.4], [ 3.7,  0.6],
    // C block (top)
    [-1.4,  1.6], [-0.7,  2.7],
    // D block (bottom)
    [-1.4, -1.6], [-0.7, -2.7],
  ]
  for (const [x, z] of spots) {
    const flower = new THREE.Mesh(
      new THREE.SphereGeometry(0.024, 5, 4),
      mat({ color: colors[ci++ % colors.length], roughness: 0.6 }),
    )
    flower.position.set(x, 0.04, z)
    g.add(flower)
  }

  return g
}

// ── smoke (animated) ─────────────────────────────────────────────────

function buildSmoke(px: number, pz: number) {
  const g = new THREE.Group()
  g.position.set(px + 0.16, 0.72, pz - 0.08)
  g.name = 'smoke'

  const particles: { offset: number; xBase: number; mat: THREE.MeshStandardMaterial }[] = []
  for (let i = 0; i < 5; i++) {
    const m = new THREE.MeshStandardMaterial({
      color: '#c8c0b0', transparent: true, opacity: 0.3, depthWrite: false,
      roughness: 1.0, metalness: 0,  // soft diffuse — smoke is a participating medium fake
    })
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 6, 6), m)
    mesh.scale.setScalar(0.016)
    g.add(mesh)
    particles.push({ offset: i * 0.4, xBase: Math.sin(i * 3.7) * 0.02, mat: m })
  }

  const update = (t: number) => {
    g.children.forEach((child, i) => {
      const p = particles[i]
      const age = ((t + p.offset) % 2) / 2
      child.position.y = age * 0.3
      child.position.x = p.xBase + Math.sin(t * 0.5 + i) * 0.02
      child.scale.setScalar(0.016 + age * 0.03)
      p.mat.opacity = 0.35 * (1 - age)
    })
  }

  return { group: g, update }
}

// ── stone path ───────────────────────────────────────────────────────

function buildStonePath(): THREE.Group {
  // Short driveway from just north of the equator road up to the hut door.
  // Hut now lives at (−1.0, 0, +0.5) with door facing +Z, so path ends near
  // (−1.0, 0, +0.72) — flush with the front wall.
  const g = new THREE.Group()
  g.name = 'stonepath'
  for (let i = 0; i < 6; i++) {
    const t = i / 5
    const r = 0.04 + Math.sin(i * 4.1) * 0.016
    const stone = new THREE.Mesh(
      new THREE.CircleGeometry(r, 6),
      mat({ color: '#8a8070', roughness: 0.95 }),
    )
    stone.position.set(
      THREE.MathUtils.lerp(-0.8, -1.0, t) + Math.sin(i * 2.3) * 0.035,
      0.01,
      THREE.MathUtils.lerp(-0.25, 0.72, t) + Math.cos(i * 1.7) * 0.03,
    )
    stone.rotation.x = -Math.PI / 2
    stone.rotation.z = i * 1.1
    g.add(stone)
  }
  return g
}

// ── well (F block) ───────────────────────────────────────────────────

function buildWell(): THREE.Group {
  const g = new THREE.Group()
  g.position.set(3.0, 0, -0.1)
  g.name = 'well'

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.2, 0.24, 8),
    mat({ color: '#8a8070', roughness: 0.95 }),
  )
  base.position.y = 0.12; base.castShadow = true
  g.add(base)

  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.024, 0.024, 0.4, 4),
      mat({ color: '#6b4c30', roughness: 0.9 }),
    )
    post.position.set(side * 0.14, 0.44, 0)
    post.castShadow = true
    g.add(post)
  }

  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(0.24, 0.12, 4),
    mat({ color: '#8b4a2a', roughness: 0.8 }),
  )
  roof.position.y = 0.7; roof.rotation.y = Math.PI / 4
  roof.castShadow = true
  g.add(roof)

  return g
}

// ── road + car (equator loop + per-region clip showcase) ─────────────
//
// The road runs along z = ROAD_Z, spanning x ∈ [−4, +4] — the full flat
// equator of the cross cube-net. When folded, it becomes a continuous ring
// around the cube equator (B → E → A → F → B). The car's single world
// position is animated along x; per-tile clip planes mean it only appears
// in whichever cube cell currently contains its position.
//
// Kept entirely inside the v=1 row (z ∈ [−1, 0]) of each equator face so
// the strip sits on one half of each face rather than straddling the
// within-face split.

const ROAD_Z     = -0.5
const ROAD_WIDTH = 0.32
// Road sits slightly above terrain so its sphere-projected radius clears the
// global SphereGeometry (radius 1.0) without z-fighting. Note: the real fix
// for the road being invisible in sphere mode was WIDTH-SUBDIVIDING the strip
// geometry below — a single 2-vertex box across 8 units projects to a chord
// that cuts through the sphere interior, not a curved surface.
const ROAD_Y     = 0.045
const BRIDGE_X0  = -0.35
const BRIDGE_X1  =  0.35
const BRIDGE_Y   =  0.24
const RAMP_LEN   = 0.25

function buildRoad(): THREE.Group {
  const g = new THREE.Group()
  g.name = 'road'

  // Asphalt strip — full equator. Since the mesh is a single BoxGeometry
  // spanning BASE_W, per-tile clip planes cut it down to each cell's cube
  // cell on every render.
  // Width-subdivided so sphere-projection can curve the strip around the cube
  // edges. A single 2-vertex box across 8 units would project into a straight
  // chord that cuts through the sphere interior — invisible under the terrain.
  // 64 segments ≈ 8 per face block, enough for the bezier-curved profile.
  const strip = new THREE.Mesh(
    new THREE.BoxGeometry(BASE_W, 0.025, ROAD_WIDTH, 64, 1, 1),
    mat({ color: '#2f2f33', roughness: 0.9, metalness: 0 }),
  )
  strip.position.set(0, ROAD_Y, ROAD_Z)
  strip.receiveShadow = true
  strip.name = 'asphalt-strip'
  g.add(strip)

  // Dashed yellow centerline. Each dash is a tiny box along x.
  const dashLen = 0.15
  const dashGap = 0.2
  for (let x = -BASE_W / 2 + 0.05; x < BASE_W / 2; x += dashLen + dashGap) {
    const dash = new THREE.Mesh(
      new THREE.BoxGeometry(dashLen, 0.002, 0.035),
      mat({ color: '#f5d86a', roughness: 0.7 }),
    )
    dash.position.set(x + dashLen / 2, ROAD_Y + 0.018, ROAD_Z)
    g.add(dash)
  }

  // Bridge deck — raised wooden span
  const deckLen = BRIDGE_X1 - BRIDGE_X0
  const deck = new THREE.Mesh(
    new THREE.BoxGeometry(deckLen, 0.05, ROAD_WIDTH + 0.06),
    mat({ color: '#7a4f2d', roughness: 0.9 }),
  )
  deck.position.set((BRIDGE_X0 + BRIDGE_X1) / 2, BRIDGE_Y, ROAD_Z)
  deck.castShadow = true
  deck.receiveShadow = true
  g.add(deck)

  // Railings — thin boxes along both sides of the deck
  for (const zSign of [-1, 1]) {
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(deckLen, 0.07, 0.02),
      mat({ color: '#5a3a1a', roughness: 0.9 }),
    )
    rail.position.set(
      (BRIDGE_X0 + BRIDGE_X1) / 2,
      BRIDGE_Y + 0.08,
      ROAD_Z + zSign * (ROAD_WIDTH / 2 + 0.01),
    )
    g.add(rail)
  }

  // Support posts — four corners of the bridge
  for (const xSide of [BRIDGE_X0, BRIDGE_X1]) {
    for (const zSign of [-1, 1]) {
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.022, 0.028, BRIDGE_Y, 6),
        mat({ color: '#4a3020', roughness: 0.9 }),
      )
      post.position.set(xSide, BRIDGE_Y / 2, ROAD_Z + zSign * (ROAD_WIDTH / 2))
      post.castShadow = true
      g.add(post)
    }
  }

  // Ramps — angled planks. The box length is the DIAGONAL distance between
  // the road corner and the bridge corner, not the horizontal run; rotating a
  // RAMP_LEN-long box by atan2(dh, RAMP_LEN) leaves it short of both ends.
  // For the left ramp the +X end is at bridge level (higher Y) → +rotation.z
  // around z-axis lifts the +X end. Right ramp mirrored.
  const dh = BRIDGE_Y - ROAD_Y
  const rampDiag = Math.sqrt(RAMP_LEN * RAMP_LEN + dh * dh)
  const rampAngle = Math.atan2(dh, RAMP_LEN)
  for (const sign of [-1, 1]) {
    const ramp = new THREE.Mesh(
      new THREE.BoxGeometry(rampDiag, 0.03, ROAD_WIDTH),
      mat({ color: '#7a4f2d', roughness: 0.9 }),
    )
    const xCenter = sign < 0
      ? BRIDGE_X0 - RAMP_LEN / 2
      : BRIDGE_X1 + RAMP_LEN / 2
    ramp.position.set(xCenter, (ROAD_Y + BRIDGE_Y) / 2, ROAD_Z)
    ramp.rotation.z = sign < 0 ? rampAngle : -rampAngle
    ramp.castShadow = true
    g.add(ramp)
  }

  return g
}

function buildCar() {
  const g = new THREE.Group()
  g.name = 'car'

  // Chassis
  const chassis = new THREE.Mesh(
    new THREE.BoxGeometry(0.26, 0.06, 0.16),
    mat({ color: '#c8483a', roughness: 0.35, metalness: 0.2 }),
  )
  chassis.position.y = 0.055
  chassis.castShadow = true
  g.add(chassis)

  // Cabin (sits on chassis, slightly shorter)
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(0.17, 0.06, 0.14),
    mat({ color: '#a83a2c', roughness: 0.35, metalness: 0.2 }),
  )
  cabin.position.set(-0.01, 0.115, 0)
  cabin.castShadow = true
  g.add(cabin)

  // Windshield
  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(0.01, 0.05, 0.12),
    mat({ color: '#9cd4e8', roughness: 0.1, metalness: 0.4, transparent: true, opacity: 0.7 }),
  )
  glass.position.set(0.075, 0.115, 0)
  g.add(glass)

  // Wheels — 4 short cylinders oriented along z
  const wheels: THREE.Mesh[] = []
  for (const front of [-1, 1]) {
    for (const side of [-1, 1]) {
      const wheel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.032, 0.032, 0.028, 10),
        mat({ color: '#1a1a1a', roughness: 0.85 }),
      )
      wheel.rotation.x = Math.PI / 2
      wheel.position.set(front * 0.09, 0.032, side * 0.085)
      g.add(wheel)
      wheels.push(wheel)
    }
  }

  const CAR_SPEED = 0.55  // world units / second — ~15 s per lap
  const update = (t: number) => {
    // Linear loop x = [−BASE_W/2, +BASE_W/2]. The wrap from +W/2 back to
    // −W/2 is a cube-edge fold (F→B) so it's visually continuous on the
    // sphere even though the flat diorama position jumps.
    const xRaw = (t * CAR_SPEED) % BASE_W
    const x = xRaw - BASE_W / 2
    g.position.x = x
    g.position.z = ROAD_Z

    // Height tracks the road profile: flat baseline, ramps, bridge deck.
    const surfaceTop = ROAD_Y + 0.012  // top of asphalt strip
    const bridgeTop  = BRIDGE_Y + 0.025
    let y = surfaceTop
    if (x >= BRIDGE_X0 && x <= BRIDGE_X1) {
      y = bridgeTop
    } else if (x >= BRIDGE_X0 - RAMP_LEN && x < BRIDGE_X0) {
      const k = (x - (BRIDGE_X0 - RAMP_LEN)) / RAMP_LEN
      y = surfaceTop + (bridgeTop - surfaceTop) * k
    } else if (x > BRIDGE_X1 && x <= BRIDGE_X1 + RAMP_LEN) {
      const k = (x - BRIDGE_X1) / RAMP_LEN
      y = bridgeTop - (bridgeTop - surfaceTop) * k
    }
    g.position.y = y

    // Gentle ramp pitch while on the ramps — matches the deck rotation
    const rampPitch = Math.atan2(BRIDGE_Y - ROAD_Y, RAMP_LEN)
    if (x >= BRIDGE_X0 - RAMP_LEN && x < BRIDGE_X0) g.rotation.z = rampPitch
    else if (x > BRIDGE_X1 && x <= BRIDGE_X1 + RAMP_LEN) g.rotation.z = -rampPitch
    else g.rotation.z = 0

    // Roll the wheels. Circumference ≈ 2π·0.032 ≈ 0.2; distance per second
    // is CAR_SPEED so angular velocity = CAR_SPEED / 0.032.
    const wheelAng = t * (CAR_SPEED / 0.032)
    for (const w of wheels) w.rotation.y = wheelAng
  }

  return { group: g, update }
}

// ── starlings flock (boids + obstacle avoidance) ─────────────────────
//
// Each bird is a tiny triangle in local XZ plane with its nose at local −Z,
// so `mesh.lookAt(pos + vel)` orients the nose along velocity for free.
// Each per-frame step:
//   1. Accumulate separation / alignment / cohesion from neighbours within
//      PERCEPTION.
//   2. Add inverse-square repulsion from hand-authored obstacle spheres so
//      the flock doesn't tunnel through the hut, windmill, trees, bridge.
//   3. Add soft boundary forces to keep the flock inside the equator band;
//      off-band points fall in cross-net padding and wouldn't render.
//   4. Clamp acceleration, integrate to velocity (clamped) and position.
//
// The flock lives in diorama-root space like the car — per-tile clip planes
// mean each bird is only visible in whichever cube cell currently contains
// its flat position, automatically.

/** Single wing — triangle base attached to the body centerline at local X=0,
 *  tip extending in local +X. Left wing is the same mesh mirrored (scale.x =
 *  −1). Rotating the wing around its local Z axis pivots at the body, so the
 *  same rotation.z on both wings flaps them together (the left mirror
 *  inverts the X component but leaves the Y lift component consistent). */
/** One wing as a triangle in the XZ plane. `side = +1` builds the right
 *  wing (tip at +X), `side = −1` the left (tip at −X). Using side-specific
 *  geometry instead of `scale.x = −1` avoids the scale-before-rotate
 *  flip-flopping that makes a shared `rotation.z` produce asymmetric
 *  (barrel-roll) flapping instead of symmetric lift. */
function wingGeometry(side: 1 | -1): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  const verts = new Float32Array([
    // Pivot edge at X=0 (body centerline).
    0,              0, -0.005,
    0,              0,  0.007,
    // Tip.
    side * 0.014,   0,  0.002,
  ])
  g.setAttribute('position', new THREE.BufferAttribute(verts, 3))
  g.computeVertexNormals()
  return g
}

function buildBirdMesh(mat: THREE.MeshStandardMaterial) {
  const g = new THREE.Group()

  // Body — cone pointing −Z (forward direction for lookAt). Tiny, ~1/10 of
  // a cell so a real starling silhouette at diorama scale.
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.0022, 0.014, 6), mat)
  body.rotation.x = -Math.PI / 2
  g.add(body)

  const rightWing = new THREE.Mesh(wingGeometry(+1), mat)
  g.add(rightWing)
  const leftWing  = new THREE.Mesh(wingGeometry(-1), mat)
  g.add(leftWing)

  return { group: g, leftWing, rightWing }
}

interface Bird {
  mesh: THREE.Group
  leftWing: THREE.Mesh
  rightWing: THREE.Mesh
  phase: number     // per-bird flap phase so the flock isn't in lock-step
  flock: number     // 0 or 1 — boids rules only apply within the same flock
  pos: THREE.Vector3
  vel: THREE.Vector3
}

// (x, y, z, radius) — spheres around bulky diorama geometry. Slightly padded
// so the flock skirts them comfortably rather than grazing.
const FLOCK_OBSTACLES: [number, number, number, number][] = [
  [-1.0,  0.30, 0.5,  0.55],  // hut + chimney
  [ 1.0,  0.55, 0.0,  0.60],  // windmill (tower + blades)
  [ 3.0,  0.35,-0.1,  0.35],  // well
  [ 0.0,  0.25,-0.5,  0.45],  // bridge deck + posts
  // Tall trees — centered on canopy height
  [-1.7,  0.30,-0.7,  0.25],
  [-0.3,  0.30, 0.7,  0.22],
  [ 0.3,  0.30,-0.7,  0.24],
  [ 1.8,  0.30, 0.6,  0.26],
  [-2.3,  0.28, 0.5,  0.22],
  [-3.5,  0.26,-0.5,  0.20],
  [-2.9,  0.28, 0.8,  0.22],
  [ 2.3,  0.26,-0.6,  0.22],
  [ 3.6,  0.28, 0.4,  0.24],
]

function buildBirds() {
  const group = new THREE.Group()
  group.name = 'birds'
  const birdMat = mat({ color: '#f8f8f8', roughness: 0.5, metalness: 0, side: THREE.DoubleSide })

  // Two initial groups of starlings. ALL birds attract ALL birds (no per-
  // flock filter) so over time the groups merge into a single tight flock
  // that shares one heading. Seeded on opposite sides of the equator with
  // a common direction so you see the merge happen in real time.
  const PER_FLOCK = 6
  const FLOCKS_INIT: { center: THREE.Vector3; vel: THREE.Vector3 }[] = [
    { center: new THREE.Vector3(-2.2, 0.55, -0.15), vel: new THREE.Vector3(0.55, 0, 0) },
    { center: new THREE.Vector3( 2.2, 0.65,  0.15), vel: new THREE.Vector3(0.55, 0, 0) },
  ]
  const birds: Bird[] = []
  for (let f = 0; f < FLOCKS_INIT.length; f++) {
    const { center, vel: seedVel } = FLOCKS_INIT[f]
    for (let k = 0; k < PER_FLOCK; k++) {
      const { group: bm, leftWing, rightWing } = buildBirdMesh(birdMat)
      // Tight clump around the flock centre (~0.1 radius).
      const pos = new THREE.Vector3(
        center.x + Math.sin(k * 2.7 + f * 1.3) * 0.10,
        center.y + Math.sin(k * 1.3 + f * 0.9) * 0.04,
        center.z + Math.sin(k * 0.9 + f * 2.1) * 0.10,
      )
      const vel = seedVel.clone()
      bm.position.copy(pos)
      bm.lookAt(pos.clone().add(vel))
      group.add(bm)
      birds.push({
        mesh: bm, leftWing, rightWing,
        phase: (f * PER_FLOCK + k) * 0.73,
        flock: f,
        pos: pos.clone(), vel,
      })
    }
  }

  // Boids tuned for attractor behaviour + tight formation:
  //   - PERCEPTION 5.0: every bird sees every other bird (equator band is
  //     ~8 wide, two groups at ±2.2 = 4.4 apart; 5.0 guarantees they see
  //     each other from the start so cohesion can pull them together).
  //   - SEP_RADIUS 0.12: only neighbours closer than this repel each other.
  //     Keeps a small personal bubble; outside this radius birds attract.
  //   - Strong alignment + cohesion, mild separation → tight flock that
  //     shares a heading rather than scattered individuals.
  const PERCEPTION  = 5.0
  const SEP_RADIUS  = 0.12
  const W_SEP = 2.0
  const W_ALI = 2.2
  const W_COH = 1.6
  const W_OBS = 3.0
  const W_BND = 2.5
  const MAX_SPEED = 0.75
  const MIN_SPEED = 0.30
  const MAX_FORCE = 3.5

  let prevT: number | null = null
  const tmp = new THREE.Vector3()
  const sepAcc = new THREE.Vector3()
  const aliAcc = new THREE.Vector3()
  const cohAcc = new THREE.Vector3()
  const obsAcc = new THREE.Vector3()
  const bndAcc = new THREE.Vector3()
  const acc    = new THREE.Vector3()

  const update = (t: number) => {
    const dt = prevT === null ? 0.016 : Math.min(0.05, t - prevT)
    prevT = t
    if (dt <= 0) return

    for (const b of birds) {
      sepAcc.set(0, 0, 0); aliAcc.set(0, 0, 0); cohAcc.set(0, 0, 0)
      obsAcc.set(0, 0, 0); bndAcc.set(0, 0, 0)
      let n = 0
      // NO flock filter — all birds attract all birds.
      for (const o of birds) {
        if (o === b) continue
        const d = b.pos.distanceTo(o.pos)
        if (d > 0 && d < PERCEPTION) {
          // Separation only kicks in within SEP_RADIUS. Outside, cohesion
          // + alignment dominate so groups get pulled together.
          if (d < SEP_RADIUS) {
            tmp.copy(b.pos).sub(o.pos).divideScalar(d * d)
            sepAcc.add(tmp)
          }
          aliAcc.add(o.vel)
          cohAcc.add(o.pos)
          n++
        }
      }
      if (n > 0) {
        aliAcc.divideScalar(n)
        cohAcc.divideScalar(n).sub(b.pos)
      }

      for (const o of FLOCK_OBSTACLES) {
        tmp.set(b.pos.x - o[0], b.pos.y - o[1], b.pos.z - o[2])
        const dist = tmp.length()
        const surface = o[3] + 0.12
        if (dist < surface) {
          const strength = 1 / Math.max(dist - o[3], 0.05)
          tmp.normalize().multiplyScalar(strength)
          obsAcc.add(tmp)
        }
      }

      // Stay on the equator band. Quadratic ramp near edges.
      const SOFT = 0.3
      if (b.pos.x < -4 + SOFT) bndAcc.x += (-4 + SOFT - b.pos.x) * 10
      if (b.pos.x >  4 - SOFT) bndAcc.x -= (b.pos.x - (4 - SOFT)) * 10
      if (b.pos.z < -0.8)      bndAcc.z += (-0.8 - b.pos.z) * 10
      if (b.pos.z >  0.8)      bndAcc.z -= (b.pos.z - 0.8) * 10
      if (b.pos.y < 0.35)      bndAcc.y += (0.35 - b.pos.y) * 12
      if (b.pos.y > 0.85)      bndAcc.y -= (b.pos.y - 0.85) * 12

      acc.set(0, 0, 0)
        .addScaledVector(sepAcc, W_SEP)
        .addScaledVector(aliAcc, W_ALI)
        .addScaledVector(cohAcc, W_COH)
        .addScaledVector(obsAcc, W_OBS)
        .addScaledVector(bndAcc, W_BND)
      if (acc.lengthSq() > MAX_FORCE * MAX_FORCE) acc.setLength(MAX_FORCE)

      b.vel.addScaledVector(acc, dt)
      const sp = b.vel.length()
      if (sp > MAX_SPEED) b.vel.multiplyScalar(MAX_SPEED / sp)
      else if (sp < MIN_SPEED && sp > 0) b.vel.multiplyScalar(MIN_SPEED / sp)

      b.pos.addScaledVector(b.vel, dt)
      b.mesh.position.copy(b.pos)
      tmp.copy(b.pos).add(b.vel)
      b.mesh.lookAt(tmp)

      const flap = Math.sin(t * 18 + b.phase) * 0.75 + 0.15
      b.rightWing.rotation.z =  flap
      b.leftWing.rotation.z  = -flap
    }
  }

  return { group, update }
}

// ── rocks (B block detail) ───────────────────────────────────────────

function buildRocks(): THREE.Group {
  const g = new THREE.Group()
  g.name = 'rocks'
  const rockPositions: [number, number, number, number][] = [
    [-2.5, 0.06,  0.3, 0.12],
    [-3.3, 0.04, -0.2, 0.08],
    [-3.8, 0.05,  0.5, 0.10],
    [-2.7, 0.04, -0.7, 0.07],
  ]
  for (const [x, y, z, r] of rockPositions) {
    const rock = new THREE.Mesh(
      new THREE.IcosahedronGeometry(r, 0),
      mat({ color: '#7a7060', roughness: 0.95 }),
    )
    rock.position.set(x, y, z)
    rock.rotation.set(x * 3, z * 2, x + z)
    rock.castShadow = true
    g.add(rock)
  }
  return g
}

// ── compose ──────────────────────────────────────────────────────────

export interface DioramaScene {
  root: THREE.Group
  update: (elapsed: number) => void
}

export interface BuildDioramaOpts {
  /** Set false to omit the flat terrain plane from the per-tile root. Used
   *  in sphere mode where a separate global SphereGeometry terrain renders
   *  once per frame (avoids per-tile clip-plane seams entirely). */
  includeTerrain?: boolean
  /** Skip building the grass + flower InstancedMeshes. Used by the
   *  saveDiorama flow — exporting the meadow would serialise hundreds of
   *  thousands of blade instance matrices into the glb and lose the
   *  shader-driven wind anyway. Meadow is rebuilt in-code on load. */
  skipMeadow?: boolean
}

/** Single global terrain mesh — a real sphere, not a sphere-projected plane.
 *  Used in sphere mode as a continuous green base under the per-tile object
 *  passes, eliminating across-face seams (no separate triangulations meeting
 *  at the curved cube edge). Material matches the per-tile terrain so any
 *  pixels not overdrawn by the per-tile pass blend in invisibly.
 *
 *  NOTE: this terrain doesn't follow rubik tile rotation; that's intentional
 *  and acceptable while the terrain is uniform green. If the terrain ever
 *  carries spatially-distinct content per tile, this needs revisiting. */
export function buildSphereTerrain(): THREE.Mesh {
  const geom = new THREE.SphereGeometry(1, 96, 64)
  const sphereMat = new THREE.MeshStandardMaterial({
    color: TERRAIN_GREEN,
    roughness: 0.95,
    metalness: 0,
  })
  const mesh = new THREE.Mesh(geom, sphereMat)
  mesh.name = 'sphere-terrain'
  // Apply triplanar grass FIRST, then Fresnel — onBeforeCompile callbacks
  // chain in reverse, so Fresnel-patch (added last) runs the triplanar
  // patch via prevOBC. Both stack cleanly.
  patchMaterialForTriplanar(sphereMat, grassTexture())
  patchMaterialForFresnel(sphereMat)
  return mesh
}

export function buildDiorama(opts: BuildDioramaOpts = {}): DioramaScene {
  const { includeTerrain = true, skipMeadow = false } = opts
  const root = new THREE.Group()
  root.name = 'diorama'

  // Central pond on +Y (top face): the world has a lake on top when folded.
  const pond = buildPond(-1.0, 2.0, 0.6, 'pond')
  // Stream on -Y (bottom): smaller reflective patch.
  const stream = buildPond(-1.2, -2.1, 0.45, 'stream')

  // Windmill on +X face (A). Well inside the A block; no seam crossing.
  const windmill = buildWindmill(1.0, 0.0)
  const trees = buildTrees()
  // Hut relocated to the v=0 (upper) row of face E so the equator road
  // running along z = −0.5 has a clear lane. Chimney smoke mirrors.
  const HUT_PX = -1.0
  const HUT_PZ = 0.5
  const smoke = buildSmoke(HUT_PX, HUT_PZ)
  // Road + car loop — wraps the cube equator, showcases per-region clipping.
  const car = buildCar()
  // Starling flock — boids flocking above the equator, dodges big meshes.
  const birds = buildBirds()

  if (includeTerrain) root.add(buildTerrain())
  root.add(pond.mesh)
  root.add(stream.mesh)
  root.add(buildHut(HUT_PX, HUT_PZ))
  root.add(windmill.group)
  root.add(trees.group)
  root.add(buildFence())
  root.add(buildFlowers())
  root.add(buildStonePath())
  root.add(smoke.group)
  root.add(buildWell())
  root.add(buildRocks())
  root.add(buildRoad())
  root.add(car.group)
  root.add(birds.group)

  // Fresnel toggle hook: every MSM in the diorama gets a uFresnelScale
  // uniform bound to the shared `fresnelUniform`. Runtime code flips the
  // uniform's value to turn the specular IBL rim on/off. Applied BEFORE the
  // grass is attached so grass material (which has its own onBeforeCompile
  // chain) is not touched by the Fresnel patch — grass is matte, doesn't
  // read specular, and keeping its shader chain clean avoids chunk-merge
  // collisions (hetvabhasa P7).
  applyFresnelPatchToScene(root)

  // Meadow runs LAST: all other props must be in `root` so their flat-space
  // AABBs are available for exclusion sampling. Authored in flat cube-net
  // coordinates, grass + flowers then ride the same per-cell → sphere
  // projection pipeline as every other prop. skipMeadow = true cuts the
  // grass meshes entirely — used by saveDiorama so the exported glb stays
  // lean and the meadow rebuilds from code on load.
  const grass = skipMeadow ? null : buildGrass(root)
  if (grass) for (const m of grass.meshes) root.add(m)

  const update = (t: number) => {
    pond.update(t)
    stream.update(t)
    windmill.update(t)
    trees.update(t)
    smoke.update(t)
    car.update(t)
    birds.update(t)
    grass?.update(t)
  }

  return { root, update }
}

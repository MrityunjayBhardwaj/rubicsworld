/**
 * Fluffy low-poly trees — adapted from the douges.dev "three.js trees"
 * technique. Foliage is built from crossed alpha-masked quads (instead of
 * solid icospheres) with a procedural noise-blob mask + ambient gradient
 * shading. Delivers the same low-poly fluffy aesthetic as the tutorial
 * without the view-space offset trick, which conflicts with our existing
 * patchMaterialForSphere vertex override (sphere mode owns
 * <project_vertex>; the tutorial's offset also owns it).
 *
 * Each tree:
 *   - tapered low-poly trunk (CylinderGeometry, 6 radial segments)
 *   - 3 crossed quads, rotated 0°/60°/120° around local +Y, placed as a
 *     canopy above the trunk
 *   - foliage material: MeshStandardMaterial + onBeforeCompile for
 *       • procedural circular+noisy alpha (no texture)
 *       • top-lighter / bottom-darker canopy gradient (fake AO)
 *     so we pay no PNG budget and the look is fully shader-authored.
 *
 * Sphere mode: materials get the usual patchMaterialForSphere patch; the
 * foliage onBeforeCompile only touches <common> + <map_fragment> so it
 * chains cleanly with the sphere projection's <project_vertex> override.
 */
import * as THREE from 'three'

export interface FluffyTreeOptions {
  position: [number, number, number]
  scale?: number
  /** Override trunk colour (default warm brown). */
  trunkColor?: THREE.ColorRepresentation
  /** Override canopy colour (default mid-green). */
  canopyColor?: THREE.ColorRepresentation
  /** Slight per-tree random seed folded into the foliage shader for noise. */
  seed?: number
}

export interface FluffyTreeResult {
  group: THREE.Group
  swayGroup: THREE.Group
}

// Single shared crossed-quads geometry (3 quads rotated around +Y). Shared
// across all trees — the per-tree canopy scale is applied via the sway
// group's scale so we don't duplicate geometry. Low-poly: 12 verts, 6 tris.
let _sharedCanopyGeom: THREE.BufferGeometry | null = null
function canopyGeometry(): THREE.BufferGeometry {
  if (_sharedCanopyGeom) return _sharedCanopyGeom
  const g = new THREE.BufferGeometry()
  const positions: number[] = []
  const uvs: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  // Three quads rotated 0°, 60°, 120° around +Y. Each quad is 1×1 centred on
  // local origin (root) with corners at (±0.5, 0.5 ± 0.5, 0) pre-rotation.
  // We want the quad to sit ABOVE the root, so shift up by +0.5.
  const half = 0.5
  const rotations = [0, Math.PI / 3, (2 * Math.PI) / 3]
  for (let r = 0; r < rotations.length; r++) {
    const base = r * 4
    const a = rotations[r]
    const cosA = Math.cos(a)
    const sinA = Math.sin(a)
    // Corners in quad-local: (-0.5, 0)→(0.5, 0)→(0.5, 1)→(-0.5, 1)  (y=height)
    const corners: [number, number][] = [
      [-half, 0],
      [ half, 0],
      [ half, 1],
      [-half, 1],
    ]
    for (const [lx, ly] of corners) {
      // Rotate around Y axis (local +Y, same as world +Y pre-instance).
      const x = lx * cosA
      const z = lx * sinA
      positions.push(x, ly, z)
    }
    // UV 0..1 so the fragment shader maps the full quad to the blob mask.
    uvs.push(0, 0,  1, 0,  1, 1,  0, 1)
    // Normal: outward in the quad's plane (perpendicular to X-in-rotated
    // frame). For our UV blob lighting we don't lean on normals heavily;
    // approximate with +Y so canopies catch sky light.
    for (let i = 0; i < 4; i++) normals.push(0, 1, 0)
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2))
  g.setAttribute('normal',   new THREE.Float32BufferAttribute(normals, 3))
  g.setIndex(indices)
  _sharedCanopyGeom = g
  return g
}

// Foliage material factory. Each tree gets its own material so the canopy
// colour uniform is per-tree — a field of identical shaders would flatten
// nicely, but a touch of hue variation between trees makes the canopy feel
// alive. patchMaterialForSphere chains onto our onBeforeCompile via prevOBC,
// so the sphere projection still applies in sphere mode.
function createFoliageMaterial(canopyColor: THREE.Color, seed: number): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.85,
    metalness: 0,
    side: THREE.DoubleSide,
    alphaTest: 0.5,
    transparent: false,
  })
  mat.onBeforeCompile = shader => {
    shader.uniforms.uCanopyColor = { value: canopyColor }
    shader.uniforms.uSeed        = { value: seed }
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */`
        #include <common>
        varying vec2 vFoliageUv;
        uniform vec3  uCanopyColor;
        uniform float uSeed;

        // Cheap, seed-varied value noise — coarse bumps at the blob edge
        // break up the circular silhouette into a fluffy outline.
        float hash21(vec2 p, float s) {
          p += s;
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float valueNoise(vec2 p, float s) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          float a = hash21(i, s);
          float b = hash21(i + vec2(1.0, 0.0), s);
          float c = hash21(i + vec2(0.0, 1.0), s);
          float d = hash21(i + vec2(1.0, 1.0), s);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
        }
        `,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */`
        // Procedural fluffy-blob alpha. Circular envelope at UV centre,
        // pushed outward by low-freq noise so the silhouette has organic
        // lumps rather than a clean disc.
        vec2 d  = vFoliageUv - vec2(0.5);
        float r = length(d) * 2.0;                        // 0 centre .. 1 edge
        float n = valueNoise(vFoliageUv * 3.2, uSeed);    // 0..1 low-freq
        float edge = 0.55 + 0.35 * n;                     // effective radius
        if (r > edge) discard;
        // Fake-AO gradient: darker at the bottom of each quad, lighter at
        // the top. Gives the canopy the classic low-poly "tree with ambient
        // occlusion baked in" read without needing real AO.
        float ao = mix(0.55, 1.0, vFoliageUv.y);
        vec3 canopy = uCanopyColor * ao;
        // Subtle per-pixel noise shading on top so the colour isn't flat.
        canopy *= 0.88 + 0.12 * n;
        diffuseColor.rgb *= canopy;
        `,
      )
    // We need the UV passed from vertex to fragment. MSM already has `vUv`
    // but only when a map/alphaMap/etc is declared. Ensure a varying ourselves
    // to be immune to chunk changes — paired with a helper macro so the
    // fragment replacement above stays readable.
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */`
        #include <common>
        varying vec2 vFoliageUv;
        `,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */`
        vec3 transformed = vec3(position);
        vFoliageUv = uv;
        `,
      )
  }
  return mat
}

// Trunk material — matte brown MSM, no shader customisation needed.
function createTrunkMaterial(color: THREE.ColorRepresentation): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.92,
    metalness: 0,
    side: THREE.DoubleSide,
  })
}

/** Build one fluffy tree. Returns the outer group (anchored at `position`)
 *  and the inner sway group — wire that into the diorama's wind sway so
 *  trees breathe alongside grass. */
export function buildFluffyTree(opts: FluffyTreeOptions): FluffyTreeResult {
  const {
    position,
    scale = 1,
    trunkColor = '#6b4c30',
    canopyColor = '#4a8a3a',
    seed = Math.random() * 100,
  } = opts

  const tree = new THREE.Group()
  tree.position.set(...position)
  tree.scale.setScalar(scale)

  const swayG = new THREE.Group()

  const trunkH = 0.36
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.055, trunkH, 6),
    createTrunkMaterial(trunkColor),
  )
  trunk.position.y = trunkH / 2
  trunk.castShadow = true
  swayG.add(trunk)

  // Canopy: one crossed-quads mesh sitting on top of the trunk. Scale the
  // canopy mesh so the unit-sized geometry becomes tree-sized. Canopy
  // radius roughly tracks tree scale but with a small variance per tree for
  // silhouette diversity.
  const canopyR = 0.26 + (seed * 0.137 % 0.08) // 0.26..0.34 deterministic-ish
  const canopyH = canopyR * 1.3
  const canopy = new THREE.Mesh(
    canopyGeometry(),
    createFoliageMaterial(new THREE.Color(canopyColor), seed),
  )
  canopy.position.y = trunkH
  canopy.scale.set(canopyR * 2, canopyH, canopyR * 2) // geometry spans -0.5..0.5 on X/Z, 0..1 on Y
  canopy.castShadow = false
  canopy.receiveShadow = false
  // Raycast ignore — the DoF focus and tile interaction should land on the
  // terrain, not a feathery transparent blob.
  canopy.raycast = () => {}
  swayG.add(canopy)

  tree.add(swayG)
  return { group: tree, swayGroup: swayG }
}

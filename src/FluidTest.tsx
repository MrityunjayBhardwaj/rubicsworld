/**
 * FluidTest — viewer + animated flowmap shader for the CellFluids 2
 * "Stylized" FBX export (converted to /public/fluid.glb via assimp).
 *
 * The actual flow shader, material factory, time registry and r3f
 * ticker live in `src/world/flow/`. This page is now a thin consumer:
 *
 *   - loads /fluid.glb and assigns a flow material (uv2 source)
 *   - mounts a stylized ground plane with a flow material (uniform source)
 *   - exposes every shader knob via Leva for tuning to the Blender preview
 *   - includes a "saveFlow" button that bakes the per-vertex flow data
 *     to a downloadable PNG
 *
 * Per-vertex data layout (verified by attribute ranges in the live load):
 *
 *   POSITION          standard
 *   NORMAL            standard
 *   TEXCOORD_0 (uv)   range ~ [-2.4, 4.4]   — world-space UV for tileable noise
 *   TEXCOORD_1 (uv1)  range ~ [-0.67, 2.0]  — second-octave or jump-offset UV
 *   TEXCOORD_2 (uv2)  range ~ [-1.06, 1.0]  — flow direction vector
 *   COLOR_0 (color)   range [0, 1]          — foam (R), depth/shore (G), …
 *
 * Served at /fluid/ via main.tsx pathname gate.
 */
import { Canvas, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { button, folder, Leva, useControls } from 'leva'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  attachFlowAttributes,
  createFlowMaterial,
  disposeFlowMaterial,
  FlowTimeTicker,
  type FlowSource,
} from './world/flow'

type Mode = 'flow' | 'shaded' | 'color0' | 'uv0' | 'uv1' | 'uv2' | 'flowDir'

function FluidScene() {
  const { gl } = useThree()
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null)
  const [info, setInfo] = useState<string>('loading…')
  const bakeRef = useRef<() => void>(() => {})

  const { mode, autoRotate, wire, ...flow } = useControls({
    mode: {
      value: 'flow' as Mode,
      options: ['flow', 'shaded', 'color0', 'uv0', 'uv1', 'uv2', 'flowDir'] satisfies Mode[],
    },
    autoRotate: { value: false, label: 'auto-rotate' },
    wire: { value: false, label: 'wireframe' },
    Flow: folder({
      flowSource: { value: 'uv2' as FlowSource, options: ['uv1', 'uv2'] as const, label: 'flow source' },
      flowRemap: { value: 0, min: 0, max: 1, step: 1, label: 'remap [0,1]→[-1,1]' },
      flowStrength: { value: 0.5, min: 0, max: 3, step: 0.01, label: 'flow strength' },
      flowSpeed: { value: 0.35, min: 0, max: 4, step: 0.01, label: 'flow speed' },
      noiseScale: { value: 1.4, min: 0.05, max: 8, step: 0.01, label: 'noise scale' },
      colorBands: { value: 0.55, min: 0, max: 1, step: 0.01, label: 'cel banding' },
      flipX: { value: false, label: 'flip flow X' },
      flipY: { value: false, label: 'flip flow Y' },
      swapXY: { value: false, label: 'swap flow X↔Y' },
    }, { collapsed: false }),
    Foam: folder({
      foamThreshold: { value: 0.55, min: 0, max: 1, step: 0.01 },
      foamSoftness:  { value: 0.08, min: 0.001, max: 0.4, step: 0.005 },
    }, { collapsed: false }),
    Colors: folder({
      shallowColor: { value: '#9be9ff', label: 'shallow' },
      midColor:     { value: '#3eaad6', label: 'mid' },
      deepColor:    { value: '#0f3a72', label: 'deep' },
      foamColor:    { value: '#ffffff', label: 'foam' },
      depthInfluence:    { value: 0.85, min: 0, max: 1, step: 0.01, label: 'depth use' },
      highlightStrength: { value: 0.4,  min: 0, max: 1, step: 0.01, label: 'lambert mix' },
    }, { collapsed: false }),
    Bake: folder({
      bakeRes: { value: 1024, options: [256, 512, 1024, 2048], label: 'resolution' },
      saveFlow: button(() => bakeRef.current()),
    }, { collapsed: false }),
    Ground: folder({
      groundVisible: { value: true, label: 'show ground' },
      groundShallow: { value: '#7ab752', label: 'shallow' },
      groundMid:     { value: '#4f8d3c', label: 'mid' },
      groundDeep:    { value: '#2c5a26', label: 'deep' },
      groundFoam:    { value: '#cfe0a3', label: 'foam' },
      groundY:       { value: -0.5, min: -2, max: 2, step: 0.01, label: 'Y offset' },
      groundSize:    { value: 8, min: 2, max: 30, step: 0.5, label: 'size' },
      groundFlowX:   { value: 0.6, min: -2, max: 2, step: 0.01, label: 'flow X' },
      groundFlowY:   { value: 0.0, min: -2, max: 2, step: 0.01, label: 'flow Y' },
      groundNoiseScale: { value: 1.6, min: 0.05, max: 8, step: 0.01, label: 'noise scale' },
    }, { collapsed: false }),
  })

  useEffect(() => {
    const loader = new GLTFLoader()
    loader.load('/fluid.glb', (g) => {
      let geom: THREE.BufferGeometry | null = null
      g.scene.traverse(o => {
        if (geom) return
        const m = o as THREE.Mesh
        if (m.isMesh) geom = m.geometry as THREE.BufferGeometry
      })
      if (!geom) { setInfo('no mesh in glb'); return }
      const g2 = geom as THREE.BufferGeometry
      const attrs = Object.keys(g2.attributes).sort()
      const counts = attrs.map(n => `${n}:${g2.attributes[n].itemSize}×${g2.attributes[n].count}`)
      const indexCount = g2.index?.count ?? 0
      g2.computeBoundingBox()
      const bb = g2.boundingBox
      if (bb) {
        const c = bb.getCenter(new THREE.Vector3())
        g2.translate(-c.x, -c.y, -c.z)
      }
      setGeometry(g2)
      setInfo(`attrs: ${counts.join('  ')}\nindices: ${indexCount}\nbbox span: ${bb ? bb.getSize(new THREE.Vector3()).toArray().map(n => n.toFixed(2)).join(' × ') : '?'}`)
      ;(window as unknown as Record<string, unknown>).__fluidGeom = g2
    }, undefined, (e) => setInfo(`load failed: ${e}`))
  }, [])

  // Fluid material — per-vertex flow from uv2 (CF2 default).
  const material = useMemo(() => createFlowMaterial({ flowSource: 'uv2' }), [])
  // Ground material — uniform flow vector since the plane has no
  // per-vertex flow data baked in. Same shader, separate uniforms.
  const groundMaterial = useMemo(() => createFlowMaterial({
    flowSource: 'uniform',
    uniformFlow: [0.6, 0],
    flowStrength: 1.0,
    foamThreshold: 0.7,
    foamSoftness: 0.05,
    colorBands: 0.65,
    shallowColor: '#7ab752',
    midColor: '#4f8d3c',
    deepColor: '#2c5a26',
    foamColor: '#cfe0a3',
    depthInfluence: 0.5,
    highlightStrength: 0.55,
  }), [])
  // Dispose-on-unmount; tickFlowTime would otherwise keep writing.
  useEffect(() => () => {
    disposeFlowMaterial(material)
    disposeFlowMaterial(groundMaterial)
  }, [material, groundMaterial])

  // Plane geometry with synthesized uv1/uv2/color attributes (the flow
  // shader's varyings would otherwise read uninitialised buffers).
  const groundGeometry = useMemo(() => {
    const g = new THREE.PlaneGeometry(8, 8, 16, 16)
    attachFlowAttributes(g, { uv1Scale: 1.7, depthRadial: true })
    return g
  }, [])

  const modeIdx = ({ flow: 0, shaded: 1, color0: 2, uv0: 3, uv1: 4, uv2: 5, flowDir: 6 } as Record<Mode, number>)[mode]

  // Push Leva → fluid uniforms each render (live refs on material.uniforms).
  const u = material.uniforms as Record<string, { value: unknown }>
  ;(u.uMode.value as number) = modeIdx
  ;(u.uFlowSpeed.value as number) = flow.flowSpeed
  ;(u.uNoiseScale.value as number) = flow.noiseScale
  ;(u.uFlowSource.value as number) = flow.flowSource === 'uv1' ? 1 : 2
  ;(u.uFlowRemap.value as number) = flow.flowRemap
  ;(u.uFlowStrength.value as number) = flow.flowStrength
  ;(u.uFlowSign.value as THREE.Vector2).set(flow.flipX ? -1 : 1, flow.flipY ? -1 : 1)
  ;(u.uFlowSwapXY.value as number) = flow.swapXY ? 1 : 0
  ;(u.uFoamThreshold.value as number) = flow.foamThreshold
  ;(u.uFoamSoftness.value as number) = flow.foamSoftness
  ;(u.uColorBands.value as number) = flow.colorBands
  ;(u.uShallowColor.value as THREE.Color).set(flow.shallowColor)
  ;(u.uMidColor.value as THREE.Color).set(flow.midColor)
  ;(u.uDeepColor.value as THREE.Color).set(flow.deepColor)
  ;(u.uFoamColor.value as THREE.Color).set(flow.foamColor)
  ;(u.uDepthInfluence.value as number) = flow.depthInfluence
  ;(u.uHighlightStrength.value as number) = flow.highlightStrength
  material.wireframe = wire

  const gu = groundMaterial.uniforms as Record<string, { value: unknown }>
  ;(gu.uMode.value as number) = modeIdx
  ;(gu.uFlowSpeed.value as number) = flow.flowSpeed
  ;(gu.uNoiseScale.value as number) = flow.groundNoiseScale
  ;(gu.uFoamThreshold.value as number) = flow.foamThreshold
  ;(gu.uFoamSoftness.value as number) = flow.foamSoftness
  ;(gu.uColorBands.value as number) = flow.colorBands
  ;(gu.uShallowColor.value as THREE.Color).set(flow.groundShallow)
  ;(gu.uMidColor.value as THREE.Color).set(flow.groundMid)
  ;(gu.uDeepColor.value as THREE.Color).set(flow.groundDeep)
  ;(gu.uFoamColor.value as THREE.Color).set(flow.groundFoam)
  ;(gu.uUniformFlow.value as THREE.Vector2).set(flow.groundFlowX, flow.groundFlowY)
  groundMaterial.wireframe = wire

  // Bake the per-vertex flow data to a 2D PNG. Channel layout:
  //   R = flow.x encoded ([-1,1]→[0,1])  G = flow.y encoded
  //   B = depth mask (color.g)            A = foam mask (color.r)
  bakeRef.current = () => {
    if (!geometry) { console.warn('[bake] no geometry'); return }
    const uvAttr = geometry.attributes.uv as THREE.BufferAttribute | undefined
    if (!uvAttr) { console.warn('[bake] mesh has no uv attribute'); return }
    let umin = Infinity, vmin = Infinity, umax = -Infinity, vmax = -Infinity
    for (let i = 0; i < uvAttr.count; i++) {
      const x = uvAttr.getX(i), y = uvAttr.getY(i)
      if (x < umin) umin = x
      if (x > umax) umax = x
      if (y < vmin) vmin = y
      if (y > vmax) vmax = y
    }
    const SIZE = flow.bakeRes
    const rt = new THREE.WebGLRenderTarget(SIZE, SIZE, { type: THREE.UnsignedByteType })
    const sceneB = new THREE.Scene()
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    const bakeMat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */`
        attribute vec2 uv1;
        attribute vec2 uv2;
        uniform vec2 uUvMin;
        uniform vec2 uUvSize;
        uniform int uFlowSource;
        uniform float uFlowRemap;
        uniform vec2 uFlowSign;
        uniform float uFlowSwapXY;
        varying vec2 vFlow;
        varying vec4 vColor0;
        void main() {
          vec2 nu = (uv - uUvMin) / max(uUvSize, vec2(1e-5));
          gl_Position = vec4(nu * 2.0 - 1.0, 0.0, 1.0);
          vec2 raw = uFlowSource == 1 ? uv1 : uv2;
          vec2 dir = mix(raw, raw * 2.0 - 1.0, uFlowRemap);
          dir = mix(dir, dir.yx, uFlowSwapXY) * uFlowSign;
          vFlow = clamp(dir, -1.0, 1.0);
          vColor0 = color;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vFlow;
        varying vec4 vColor0;
        void main() {
          gl_FragColor = vec4(vFlow * 0.5 + 0.5, vColor0.g, vColor0.r);
        }
      `,
      uniforms: {
        uUvMin:  { value: new THREE.Vector2(umin, vmin) },
        uUvSize: { value: new THREE.Vector2(umax - umin, vmax - vmin) },
        uFlowSource: { value: flow.flowSource === 'uv1' ? 1 : 2 },
        uFlowRemap:  { value: flow.flowRemap },
        uFlowSign:   { value: new THREE.Vector2(flow.flipX ? -1 : 1, flow.flipY ? -1 : 1) },
        uFlowSwapXY: { value: flow.swapXY ? 1 : 0 },
      },
      vertexColors: true,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    })
    const meshB = new THREE.Mesh(geometry, bakeMat)
    sceneB.add(meshB)
    const prevTarget = gl.getRenderTarget()
    const prevClear = new THREE.Color()
    gl.getClearColor(prevClear)
    const prevAlpha = gl.getClearAlpha()
    gl.setRenderTarget(rt)
    gl.setClearColor(new THREE.Color(0.5, 0.5, 0), 0)
    gl.clear(true, true, true)
    gl.render(sceneB, cam)
    const pixels = new Uint8Array(SIZE * SIZE * 4)
    gl.readRenderTargetPixels(rt, 0, 0, SIZE, SIZE, pixels)
    gl.setRenderTarget(prevTarget)
    gl.setClearColor(prevClear, prevAlpha)
    rt.dispose()
    bakeMat.dispose()
    const canvas = document.createElement('canvas')
    canvas.width = SIZE
    canvas.height = SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) { console.warn('[bake] no 2d context'); return }
    const img = ctx.createImageData(SIZE, SIZE)
    for (let y = 0; y < SIZE; y++) {
      const src = (SIZE - 1 - y) * SIZE * 4
      img.data.set(pixels.subarray(src, src + SIZE * 4), y * SIZE * 4)
    }
    ctx.putImageData(img, 0, 0)
    canvas.toBlob(b => {
      if (!b) { console.warn('[bake] toBlob failed'); return }
      const url = URL.createObjectURL(b)
      const a = document.createElement('a')
      a.href = url
      a.download = `flowmap_${SIZE}.png`
      a.click()
      URL.revokeObjectURL(url)
      // eslint-disable-next-line no-console
      console.log(`[bake] flowmap_${SIZE}.png saved (${b.size} bytes). Channels: R=flow.x  G=flow.y  B=depth(color.g)  A=foam(color.r). UV0 range was [${umin.toFixed(3)},${umax.toFixed(3)}] × [${vmin.toFixed(3)},${vmax.toFixed(3)}].`)
    }, 'image/png')
  }

  return (
    <>
      <FlowTimeTicker />
      <ambientLight intensity={0.5} />
      <directionalLight position={[3, 5, 2]} intensity={1.2} />
      {flow.groundVisible && (
        <mesh
          position={[0, flow.groundY, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
          scale={[flow.groundSize / 8, flow.groundSize / 8, 1]}
        >
          <primitive attach="geometry" object={groundGeometry} />
          <primitive attach="material" object={groundMaterial} />
        </mesh>
      )}
      {geometry && (
        <mesh
          rotation={autoRotate ? [0, performance.now() * 0.0002, 0] : [0, 0, 0]}
        >
          <primitive attach="geometry" object={geometry} />
          <primitive attach="material" object={material} />
        </mesh>
      )}
      <gridHelper args={[6, 12, '#333', '#222']} position={[0, -0.5, 0]} />
      <axesHelper args={[1]} />
      <Html info={info} />
    </>
  )
}

function Html({ info }: { info: string }) {
  useEffect(() => {
    const el = document.getElementById('fluid-hud')
    if (el) el.textContent = info
  }, [info])
  return null
}

export function FluidTest() {
  return (
    <>
      <Canvas
        camera={{ position: [3, 2, 3], fov: 45 }}
        style={{ position: 'fixed', inset: 0, background: '#0a0e0a' }}
      >
        <FluidScene />
        <OrbitControls />
      </Canvas>
      <Leva />
      <pre id="fluid-hud" style={{
        position: 'fixed', top: 8, left: 8, padding: '8px 12px',
        background: 'rgba(0,0,0,0.55)', color: '#9ec3ff',
        font: '12px/1.5 monospace', borderRadius: 4,
        pointerEvents: 'none', whiteSpace: 'pre', margin: 0,
      }} />
    </>
  )
}

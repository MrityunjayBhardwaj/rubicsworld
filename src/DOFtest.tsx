import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { EffectComposer, DepthOfField, Bloom } from '@react-three/postprocessing'
import { Leva, useControls } from 'leva'
import { useRef, useEffect } from 'react'
import type { DepthOfFieldEffect } from 'postprocessing'

/**
 * Minimal DoF repro.
 *
 * Props go directly to <DepthOfField> (constructor path). @react-three/
 * postprocessing's wrapper re-instantiates the effect whenever any of these
 * props change — so each slider change creates a FRESH DoF with the slider
 * values baked in. This is the canonical postprocessing pattern.
 *
 * If slider changes don't visibly alter the scene → effect isn't actually
 * running. If they do → the main-app bug is in our imperative uniform-write
 * pattern or in the composite-depth integration.
 */

export function DOFTest() {
  const { focusDistance, focusRange, bokehScale, showBloom } = useControls('DoF', {
    focusDistance: { value: 8, min: 0.1, max: 30, step: 0.1, label: 'focusDistance (m)' },
    focusRange:    { value: 1, min: 0.05, max: 30, step: 0.05, label: 'focusRange (m)' },
    bokehScale:    { value: 4, min: 0, max: 40, step: 0.1, label: 'bokeh' },
    showBloom:     { value: false, label: 'add bloom (sanity: non-DoF effect works?)' },
  })

  const dofRef = useRef<DepthOfFieldEffect | null>(null)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      ;(window as unknown as Record<string, unknown>).__doftest = dofRef.current
    }
  }, [focusDistance, focusRange, bokehScale])

  const boxes: { pos: [number, number, number]; color: string }[] = [
    { pos: [ 0, 0,  3], color: '#ff5a5a' },  // near   (~5m)
    { pos: [ 0, 0,  0], color: '#6ee7b7' },  // mid    (~8m)
    { pos: [ 0, 0, -3], color: '#60a5fa' },  // far    (~11m)
    { pos: [-3, 0,  0], color: '#fbbf24' },  // left   (~8.5m)
    { pos: [ 3, 0,  0], color: '#c084fc' },  // right  (~8.5m)
  ]

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#0b1020' }}>
      <Leva collapsed={false} />
      <div style={{
        position: 'fixed', top: 8, left: 8, zIndex: 1000,
        color: '#fff', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.4,
        background: 'rgba(0,0,0,0.55)', padding: '8px 10px', borderRadius: 4,
        pointerEvents: 'none', maxWidth: 380,
      }}>
        <div><strong>DOF test — minimal scene</strong></div>
        <div>red(+3,~5m) green(0,~8m) blue(-3,~11m) yellow(left) purple(right)</div>
        <div>Camera z=8. Slide focusDistance 5→8→11 — each box should sharpen in turn.</div>
        <div>Probe: <code>window.__doftest.cocMaterial.uniforms</code></div>
      </div>
      <Canvas
        camera={{ position: [0, 0, 8], fov: 45, near: 0.01, far: 1000 }}
        gl={{ antialias: false }}
        dpr={[1, 2]}
      >
        <ambientLight intensity={0.45} />
        <directionalLight position={[5, 6, 4]} intensity={1.1} />
        <mesh position={[0, -1.1, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[40, 40]} />
          <meshStandardMaterial color="#1f2937" />
        </mesh>
        {boxes.map((b, i) => (
          <mesh key={i} position={b.pos}>
            <boxGeometry args={[1, 1, 1]} />
            <meshStandardMaterial color={b.color} />
          </mesh>
        ))}
        <OrbitControls enablePan />
        <EffectComposer multisampling={0}>
          <DepthOfField
            ref={dofRef}
            focusDistance={focusDistance}
            focusRange={focusRange}
            bokehScale={bokehScale}
          />
          {showBloom ? <Bloom intensity={1.5} luminanceThreshold={0.0} mipmapBlur /> : <></>}
        </EffectComposer>
      </Canvas>
    </div>
  )
}

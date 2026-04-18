import { useState, useCallback } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, TrackballControls } from '@react-three/drei'
import * as THREE from 'three'
import { Ring } from './world/Ring'
import { Interaction } from './world/Interaction'
import { AiSeed } from './world/AiSeed'
import { PostFx } from './world/PostFx'
import { TileLabels, TileLabelsLegend } from './world/TileLabels'
import { HDRIEnvironment } from './world/HDRIEnvironment'
import { HDRIPanel } from './world/HDRIPanel'
import { TileGrid } from './diorama/TileGrid'
import { DioramaGrid } from './diorama/DioramaGrid'
import { BezierCurveEditor } from './diorama/BezierCurveEditor'
import { Controls } from './Controls'
import { usePlanet } from './world/store'

if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__planet = usePlanet
}

function Cursor() {
  const onPlanet = usePlanet(s => s.onPlanet)
  const drag = usePlanet(s => s.drag)
  const cursor = drag ? 'grabbing' : onPlanet ? 'grab' : 'default'
  return (
    <style>{`canvas { cursor: ${cursor}; }`}</style>
  )
}

export default function App() {
  const [preview, setPreview] = useState<false | 'grid' | 'split' | 'cube'>(false)
  const [bezier, setBezier] = useState({ cx1: 0.25, cy1: 0.1, cx2: 0.75, cy2: 0.9 })
  const onBezierChange = useCallback((cx1: number, cy1: number, cx2: number, cy2: number) => {
    setBezier({ cx1, cy1, cx2, cy2 })
  }, [])

  return (
    <>
      <Controls dioramaPreview={preview} setDioramaPreview={setPreview} />
      <Cursor />
      <TileLabelsLegend />
      <HDRIPanel />
      {!preview && <BezierCurveEditor {...bezier} onChange={onBezierChange} />}
      <Canvas
        camera={{
          position: preview ? [0, 22, 0.1] : [2.4, 1.6, 2.8],
          fov: preview ? 50 : 45,
          near: 0.01,
        }}
        shadows={!!preview}
        gl={{ antialias: true, stencil: true }}
        dpr={[1, 2]}
      >
        <color attach="background" args={['#0a0d12']} />
        {preview === 'grid' ? (
          <>
            <DioramaGrid />
            <gridHelper args={[4, 8, '#333', '#222']} position={[0, -0.02, 0]} />
            <TileLabels mode="grid" />
          </>
        ) : preview === 'split' || preview === 'cube' ? (
          <>
            <TileGrid mode={preview} />
            <gridHelper args={[8, 16, '#333', '#222']} position={[0, -0.02, 0]} />
            <TileLabels mode={preview} />
          </>
        ) : (
          <>
            <HDRIEnvironment />
            <TileGrid mode="sphere" bezier={bezier} />
            <Ring />
            <Interaction />
            <AiSeed />
            <TileLabels mode="sphere" />
            <PostFx />
          </>
        )}
        {preview ? (
          <OrbitControls
            enablePan={true}
            mouseButtons={{
              LEFT: THREE.MOUSE.ROTATE,
              MIDDLE: THREE.MOUSE.DOLLY,
              RIGHT: THREE.MOUSE.PAN,
            }}
            minDistance={0.5}
            maxDistance={20}
          />
        ) : (
          // Trackball for the sphere — quaternion-based, no up-vector lock,
          // so dragging past the poles wraps seamlessly for a true 360° orbit.
          <TrackballControls
            rotateSpeed={3}
            zoomSpeed={1}
            panSpeed={0.8}
            noPan={true}
            minDistance={2.5}
            maxDistance={8}
            staticMoving={false}
            dynamicDampingFactor={0.15}
          />
        )}
      </Canvas>
    </>
  )
}

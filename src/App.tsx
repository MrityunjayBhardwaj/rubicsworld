import { useState, useCallback, useEffect } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { Leva } from 'leva'
import * as THREE from 'three'
import { Ring } from './world/Ring'
import { Interaction } from './world/Interaction'
import { WalkControls } from './world/WalkControls'
import { IntroCinematic } from './world/IntroCinematic'
import { TutorialHint, TutorialChrome } from './world/TutorialOverlay'
import { AiSeed } from './world/AiSeed'
import { PostFx } from './world/PostFx'
import { TileLabels, TileLabelsLegend } from './world/TileLabels'
import { HDRIEnvironment } from './world/HDRIEnvironment'
import { HDRIPanel } from './world/HDRIPanel'
import { GrassPanel } from './world/GrassPanel'
import { AudioBus } from './world/audio/AudioBus'
import { AudioPanel } from './world/audio/AudioPanel'
import { SoundVisualizer } from './world/audio/SoundVisualizer'
import { CubeSphere } from './world/CubeSphere'
import { TileGrid } from './diorama/TileGrid'
import { DioramaGrid } from './diorama/DioramaGrid'
import { BezierCurveEditor } from './diorama/BezierCurveEditor'
import { Controls } from './Controls'
import { usePlanet } from './world/store'
import { NEIGHBOR_IDX } from './world/rotation'
import { hudUniforms } from './diorama/buildDiorama'
import { useHdri } from './world/hdriStore'

if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__planet = usePlanet
  ;(window as unknown as Record<string, unknown>).__neighborIdx = NEIGHBOR_IDX
  ;(window as unknown as Record<string, unknown>).__hud = hudUniforms
  ;(window as unknown as Record<string, unknown>).__hdri = useHdri
}

function Cursor() {
  const onPlanet = usePlanet(s => s.onPlanet)
  const drag = usePlanet(s => s.drag)
  const cursor = drag ? 'grabbing' : onPlanet ? 'grab' : 'default'
  return (
    <style>{`canvas { cursor: ${cursor}; }`}</style>
  )
}

function SphereCamera() {
  // OrbitControls for third-person orbit around the planet. Unmounted when
  // walk mode is active so it doesn't fight WalkControls for the camera.
  const cameraMode = usePlanet(s => s.cameraMode)
  const introPhase = usePlanet(s => s.introPhase)
  if (cameraMode === 'walk') return null
  // Auto-orbit during attract phases only. In 'tutorial' the user is
  // targeting specific tiles — a moving planet fights the overlay's hint.
  const autoRotate = introPhase !== 'done' && introPhase !== 'tutorial'
  return (
    <OrbitControls
      key="sphere"
      makeDefault
      enablePan={false}
      minDistance={2.5}
      maxDistance={8}
      rotateSpeed={0.8}
      enableDamping
      dampingFactor={0.08}
      autoRotate={autoRotate}
      autoRotateSpeed={0.9}
    />
  )
}

function DevSceneExpose() {
  // Dev helper: expose the R3F scene to window for debugging HDRI state.
  const { scene } = useThree()
  useEffect(() => {
    if (import.meta.env.DEV) {
      ;(window as unknown as Record<string, unknown>).__scene = scene
    }
  }, [scene])
  return null
}

export default function App() {
  const [preview, setPreview] = useState<false | 'grid' | 'split' | 'cube' | 'rubik'>(false)
  const [bezier, setBezier] = useState({ cx1: 0.25, cy1: 0.1, cx2: 0.75, cy2: 0.9 })
  const onBezierChange = useCallback((cx1: number, cy1: number, cx2: number, cy2: number) => {
    setBezier({ cx1, cy1, cx2, cy2 })
  }, [])
  // 'rubik' is a classic top-down-perspective view of the cube-sphere (the
  // first-version planet, no diorama, no HDRI chrome). It gets its own
  // camera profile — not the orthographic-ish top-down of grid/split/cube.
  const isTopDownPreview = preview === 'grid' || preview === 'split' || preview === 'cube'
  const isRubik = preview === 'rubik'
  // Hide Leva (and the HDRI/Grass panels live inside it) while in walk
  // mode — clears the screen of HUD chrome so the cursor only ever lands
  // on the canvas. Esc / Tab returns to orbit and Leva pops back.
  const cameraMode = usePlanet(s => s.cameraMode)
  const levaHidden = cameraMode === 'walk'

  return (
    <>
      {/*
        Leva mounted inside a resize-host: wide default (480px) so the
        long auto-generated keys in the Audio panel (e.g. windmill_whoosh
        __speed) aren't truncated, and `resize: horizontal` on the host
        lets the user drag the bottom-right corner to widen further.
        `<Leva fill />` makes the panel fill its parent.
      */}
      <div
        id="leva-host"
        style={{
          position: 'fixed',
          top: 10,
          right: 10,
          width: 480,
          minWidth: 280,
          maxWidth: 900,
          height: '92vh',          // explicit height so overflow-y can scroll
          resize: 'horizontal',
          overflowX: 'hidden',     // resize handle still works with non-visible overflow
          overflowY: 'auto',       // vertical scroll when Audio panel rows expand past viewport
          zIndex: 1000,
          display: levaHidden ? 'none' : 'block',
        }}
      >
        <Leva fill hidden={levaHidden} />
      </div>
      <Controls dioramaPreview={preview} setDioramaPreview={setPreview} />
      <Cursor />
      <TileLabelsLegend />
      <HDRIPanel />
      {!preview && <AudioPanel />}
      {!preview && <GrassPanel />}
      {!preview && <BezierCurveEditor {...bezier} onChange={onBezierChange} />}
      <TutorialChrome />
      <Canvas
        camera={{
          position: isTopDownPreview ? [0, 22, 0.1] : isRubik ? [3.2, 2.2, 3.2] : [2.4, 1.6, 2.8],
          fov: isTopDownPreview ? 50 : 45,
          near: 0.01,
        }}
        shadows={isTopDownPreview}
        // antialias disabled: SMAA runs in the PostFx effect chain instead, so
        // the effect composer sees crisp edges and so Path 2 (realism-effects
        // SSGI/TRAA) can later take full control of MSAA. toneMapping moved
        // to the renderer (ACES Filmic) so effect passes receive linear input.
        gl={{ antialias: false, stencil: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.35 }}
        dpr={[1, 2]}
      >
        <color attach="background" args={['#0a0d12']} />
        <DevSceneExpose />
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
        ) : preview === 'rubik' ? (
          <>
            {/* Classic first-version planet: per-tile cube-sphere geometry from
                buildAllTileGeometries, no diorama projection, no HDRI. Uses the
                same usePlanet store + Interaction pipeline so slice rotation /
                scramble / solve all work the same as the main sphere view. */}
            <ambientLight intensity={0.45} />
            <directionalLight position={[4, 6, 3]} intensity={1.1} />
            <CubeSphere />
            <Ring />
            <Interaction />
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
            <WalkControls />
            <IntroCinematic />
            <TutorialHint />
            <AudioBus />
            <SoundVisualizer />
          </>
        )}
        {preview ? (
          <OrbitControls
            key={`preview-${preview}`}
            makeDefault
            enablePan
            mouseButtons={{
              LEFT: THREE.MOUSE.ROTATE,
              MIDDLE: THREE.MOUSE.DOLLY,
              RIGHT: THREE.MOUSE.PAN,
            }}
            minDistance={0.5}
            maxDistance={60}
          />
        ) : (
          // Sphere-mode camera routing: OrbitControls for third-person orbit,
          // auto-unmounted when WalkControls takes over. Polar-lock is a
          // feature for a grounded planet sim (Trackball's free-roll past the
          // poles disoriented more than it helped).
          <SphereCamera />
        )}
      </Canvas>
    </>
  )
}

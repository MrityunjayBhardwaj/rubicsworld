import { useState, useCallback, useEffect } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { OrbitControls, GizmoHelper, GizmoViewport } from '@react-three/drei'
import { Leva } from 'leva'
import * as THREE from 'three'
import { Ring } from './world/Ring'
import { Interaction } from './world/Interaction'
import { WalkControls } from './world/WalkControls'
import { IntroCinematic } from './world/IntroCinematic'
import { MenuOverlay } from './world/MenuOverlay'
import { StatsOverlay } from './world/StatsOverlay'
import { Stopwatch } from './world/Stopwatch'
import { TutorialHint, TutorialChrome } from './world/TutorialOverlay'
import { FpsMeter } from './world/FpsMeter'
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
import { loadLevelSettings } from './settings/levelSettings'

if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__planet = usePlanet
  ;(window as unknown as Record<string, unknown>).__neighborIdx = NEIGHBOR_IDX
  ;(window as unknown as Record<string, unknown>).__hud = hudUniforms
  ;(window as unknown as Record<string, unknown>).__hdri = useHdri
  // Dev-only audio diagnostic: window.__audio.dumpLoops() shows per-loop
  // gain state, used to chase sounds that escape the mute path.
  void import('./world/audio/bus').then(m => {
    ;(window as unknown as Record<string, unknown>).__audio = m.audioBus
  })
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

function AxesGizmo() {
  // Screen-space corner viewport showing world X (red) / Y (green) / Z (blue).
  // Toggled by store.showAxes via Controls panel. Click an axis label to snap
  // the active OrbitControls camera to that axis (works in any preview mode).
  const showAxes = usePlanet(s => s.showAxes)
  if (!showAxes) return null
  return (
    <GizmoHelper alignment="bottom-right" margin={[80, 80]}>
      <GizmoViewport
        axisColors={['#e85a5a', '#5ae87a', '#5a8ae8']}
        labelColor="#0a0d12"
      />
    </GizmoHelper>
  )
}

interface AppProps {
  /** Route gate: 'dev' = full playground (Leva, Controls, panels, preview
   *  modes — current root-route behavior). 'game' = jam route at /game/:
   *  no Leva chrome, no dev tools, no preview modes. Settings panels
   *  (HDRI / Audio / Grass) stay mounted-but-hidden so their useControls
   *  side effects (mask rasterisation, HDRI selection, audio bus init)
   *  still shape the scene.
   *
   *  'audio-edit' = inside `/edit/levels/<slug>/audio` (issue #51). Same
   *  chrome-hidden behavior as 'game' (audio editor owns its own UI on
   *  the left), but the Canvas is wrapped in a fixed-positioned div that
   *  reads `--audio-editor-canvas-left` from the document root so the
   *  splitter can drag the boundary. Without this, R3F's default 100vw
   *  Canvas overlaps the workspace panel. */
  route?: 'dev' | 'game' | 'audio-edit'
}

export default function App({ route = 'dev' }: AppProps) {
  const isGame = route === 'game'
  const isAudioEdit = route === 'audio-edit'
  // Treat audio-edit like game for chrome decisions — hide Leva, hide
  // dev-only HUD. Canvas wrapping is handled separately below.
  const noChrome = isGame || isAudioEdit
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
  // IntroCinematic is gated on the 'playing' game phase (game route only).
  // During 'title' the planet renders solved (initial store state) and
  // SphereCamera's autoRotate continues because `introPhase: 'orbit-solved'`
  // keeps the attract going — the title overlay sits on top of that
  // backdrop. On Begin → 'playing', IntroCinematic mounts fresh and runs
  // the scramble cinematic (or first-visit tutorial). returnToTitle
  // unmounts it so the next Begin gets a clean first-mount.
  const gamePhase = usePlanet(s => s.gamePhase)

  // Per-level settings layering: load <slug>/settings.json and deep-merge
  // it onto the global defaults whenever the active level changes. Walk
  // mode reads playerHeight from the merged view so each planet's eye-line
  // can differ. Best-effort — fetch failure leaves the live view at globals.
  const currentPlanetSlug = usePlanet(s => s.currentPlanetSlug)
  useEffect(() => {
    void loadLevelSettings(currentPlanetSlug)
  }, [currentPlanetSlug])

  // Live-link beacon: post the active level slug to the dev server every
  // few seconds so the Blender addon's "Auto" mode knows which slot to
  // export into. Dev-only — production builds skip the heartbeat entirely.
  // The beacon is best-effort; failures are silently swallowed (the addon
  // falls back to its dropdown selection if the endpoint is unreachable).
  useEffect(() => {
    if (!import.meta.env.DEV) return
    let cancelled = false
    const post = () => {
      if (cancelled) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void fetch('/__levels/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: currentPlanetSlug }),
      }).catch(() => { /* best-effort, ignore */ })
    }
    post() // fire immediately on slug change so Auto picks up the switch fast
    const id = window.setInterval(post, 2000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [currentPlanetSlug])

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
          display: (levaHidden || noChrome) ? 'none' : 'block',
        }}
      >
        {/* On /game/ Leva itself stays mounted (with hidden=true and the
            host display:none) because the three settings panels below
            (HDRIPanel, AudioPanel, GrassPanel) call useControls — without
            a Leva store hooked up to React, those values would still
            resolve from defaults but the inline schema callbacks (button
            actions, paste-import) become orphaned. Mounting Leva hidden
            keeps the store + schema wiring intact while showing nothing
            on screen. Pure dev-only UI (Controls, BezierCurveEditor,
            TileLabelsLegend, FpsMeter) stays gated below — they're not
            settings, they're dev tools. */}
        <Leva fill hidden={levaHidden || noChrome} />
      </div>
      {!noChrome && <Controls dioramaPreview={preview} setDioramaPreview={setPreview} />}
      <Cursor />
      {!noChrome && <TileLabelsLegend />}
      {/* HDRIPanel mounts its OWN fixed-position div (not inside Leva), so
          hiding Leva chrome doesn't hide it. Wrap with display:none on
          /game/ so the useControls schema registration + side effects
          still run (HDRI selection, image upload callback) — only the
          visible panel chrome is hidden. */}
      <div style={{ display: noChrome ? 'none' : 'contents' }}>
        <HDRIPanel />
      </div>
      {!preview && <AudioPanel />}
      {!preview && <GrassPanel />}
      {!noChrome && !preview && <BezierCurveEditor {...bezier} onChange={onBezierChange} />}
      <TutorialChrome />
      {!noChrome && <FpsMeter />}
      {/* Audio-edit route wraps the Canvas in a fixed-positioned div whose
          left edge tracks `--audio-editor-canvas-left` (set by the editor's
          splitter component on document.documentElement). Without this,
          R3F's default 100vw Canvas overlaps the workspace panel. The
          Canvas inherits its parent's box, so position:fixed with explicit
          left/right/top/bottom is what constrains it. */}
      <div
        style={isAudioEdit ? {
          position: 'fixed',
          top: 0, right: 0, bottom: 0,
          left: 'var(--audio-editor-canvas-left, 480px)',
          overflow: 'hidden',
        } : { display: 'contents' }}
      >
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
        // Cap pixel ratio at 1.5: on 2x retina the FB shrinks from ~5.8M
        // pixels to ~3.3M (~56%), big fragment-shading win for the 24-pass
        // sphere render + DoF blur with negligible visual cost. SMAA in
        // the PostFx chain handles edge AA at any DPR.
        dpr={[1, 1.5]}
      >
        <color attach="background" args={['#0a0d12']} />
        <DevSceneExpose />
        <AxesGizmo />
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
            {/* IntroCinematic gating depends on route:
                  dev  → mount unconditionally (legacy: cinematic plays on
                         every page load, regardless of gamePhase).
                  game → mount only when gamePhase==='playing' so the title
                         screen attract holds the planet at the solved
                         orbit-solved phase until the user clicks Begin. */}
            {(isGame ? gamePhase === 'playing' : true) && <IntroCinematic />}
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
      </div>
      {isGame && <MenuOverlay />}
      {isGame && <StatsOverlay />}
      {isGame && <Stopwatch />}
    </>
  )
}

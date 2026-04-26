// Debug visualiser: renders a small DOM marker (icon + key name + live gain
// bar) at each registered loop's world position. Toggled by the Audio panel.
//
// Mounted inside the main Canvas tree as a sibling of <AudioBus />. Uses
// drei's Html so the marker tracks a 3D position but renders as a real DOM
// element (cheap, crisp text, no font asset). Position + gain bar update
// each frame via refs — no per-frame React state churn.

import { useEffect, useMemo, useRef, type CSSProperties } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import { audioBus, REGISTRY, type LoopDef } from './bus'
import { useAudioUi } from './audioUiStore'

const WORLD_BASE_HEIGHT = 1.8       // y of world-anchor markers above origin
const WORLD_SPREAD = 0.5            // horizontal spacing between world markers
const CAMERA_OFFSET_Y = 0.25        // marker float-up distance over the camera

const cardStyle: CSSProperties = {
  fontFamily: 'ui-monospace, monospace',
  fontSize: 11,
  color: '#fff',
  background: 'rgba(0,0,0,0.55)',
  border: '1px solid rgba(255,255,255,0.25)',
  borderRadius: 4,
  padding: '3px 6px',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
  userSelect: 'none',
  transform: 'translate(-50%, -100%)',
}

const barWrapStyle: CSSProperties = {
  marginTop: 2,
  width: 80,
  height: 3,
  background: 'rgba(255,255,255,0.18)',
  borderRadius: 2,
  overflow: 'hidden',
}

const barFillStyle: CSSProperties = {
  height: '100%',
  background: '#7af6c8',
  width: '0%',
  transition: 'width 80ms linear',
}

export function SoundVisualizer() {
  const show = useAudioUi(s => s.showVisualizer)
  if (!show) return null

  // Pre-compute per-key world-marker x offsets so they don't stack at origin.
  const worldKeys = REGISTRY.loops.filter(l => l.anchor === 'world').map(l => l.key)
  const worldXOffset: Record<string, number> = {}
  worldKeys.forEach((k, i) => {
    worldXOffset[k] = (i - (worldKeys.length - 1) / 2) * WORLD_SPREAD
  })

  return (
    <group>
      {REGISTRY.loops.map(def => (
        <SoundMarker key={def.key} def={def} worldXOffset={worldXOffset[def.key] ?? 0} />
      ))}
      {REGISTRY.loops.map(def => (
        (def.anchor.startsWith('object:') && (def.maxDist != null || def.radius != null))
          ? <ReachSphere key={`reach-${def.key}`} def={def} />
          : null
      ))}
    </group>
  )
}

// Wireframe sphere parented to the anchor showing the sound's effective
// reach. Re-parents on anchor change. Opacity pulses with live gain so an
// idle sound has a faint outline and an audible one glows. Lives in the
// same Scene as the anchor (which may be the diorama dScene, not the
// main R3F scene) — that way the sphere occludes correctly with whatever
// rendered around the anchor.
function ReachSphere({ def }: { def: LoopDef }) {
  const mesh = useMemo(() => {
    const geom = new THREE.SphereGeometry(1, 28, 18)
    const mat = new THREE.MeshBasicMaterial({
      wireframe: true,
      transparent: true,
      opacity: 0.16,
      color: '#7af6c8',
      depthWrite: false,
    })
    const m = new THREE.Mesh(geom, mat)
    m.name = `reach_${def.key}`
    m.frustumCulled = false
    return m
  }, [def.key])

  const parentRef = useRef<THREE.Object3D | null>(null)

  useEffect(() => {
    return () => {
      mesh.parent?.remove(mesh)
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
  }, [mesh])

  useFrame(() => {
    // getEffectiveRadius returns the override (panel slider) when set,
    // otherwise falls back to the registry value.
    const radius = audioBus.getEffectiveRadius(def.key)
    if (radius <= 0) return
    const id = def.anchor.slice('object:'.length)
    const target = audioBus.getAnchor(id) ?? null
    if (target !== parentRef.current) {
      if (parentRef.current === mesh.parent) parentRef.current?.remove(mesh)
      if (target) target.add(mesh)
      parentRef.current = target
    }
    if (!target) return
    mesh.scale.setScalar(radius)
    const g = audioBus.getLastLoopGain(def.key)
    const mat = mesh.material as THREE.MeshBasicMaterial
    mat.opacity = 0.08 + Math.min(1, g) * 0.35
  })

  return null
}

function SoundMarker({ def, worldXOffset }: { def: LoopDef; worldXOffset: number }) {
  const groupRef = useRef<THREE.Group>(null)
  const cardRef  = useRef<HTMLDivElement>(null)
  const fillRef  = useRef<HTMLDivElement>(null)
  const { camera } = useThree()
  const scratch = useRef(new THREE.Vector3())

  useFrame(() => {
    const grp = groupRef.current
    if (!grp) return
    const p = grp.position
    if (def.anchor === 'world') {
      p.set(worldXOffset, WORLD_BASE_HEIGHT, 0)
    } else if (def.anchor === 'camera_motion') {
      // Float just above the camera in world space.
      p.copy(camera.position)
      const up = scratch.current.set(0, 1, 0).applyQuaternion(camera.quaternion)
      p.addScaledVector(up, CAMERA_OFFSET_Y)
    } else {
      const id = def.anchor.slice('object:'.length)
      const target = audioBus.getAnchor(id)
      if (target) {
        target.getWorldPosition(p)
        // Lift slightly above the anchor so the marker doesn't intersect
        // the mesh.
        p.y += 0.12
      } else {
        // Anchor not registered yet — park off-screen.
        p.set(1e6, 1e6, 1e6)
      }
    }
    // Gain readout.
    const g = audioBus.getLastLoopGain(def.key)
    if (cardRef.current) cardRef.current.style.opacity = String(0.35 + Math.min(1, g) * 0.65)
    if (fillRef.current) fillRef.current.style.width = `${Math.round(Math.min(1, g) * 100)}%`
  })

  return (
    <group ref={groupRef}>
      <Html center distanceFactor={8} occlude={false} zIndexRange={[100, 0]}>
        <div ref={cardRef} style={cardStyle}>
          <span style={{ marginRight: 4 }}>🔊</span>{def.key}
          <div style={barWrapStyle}><div ref={fillRef} style={barFillStyle} /></div>
        </div>
      </Html>
    </group>
  )
}

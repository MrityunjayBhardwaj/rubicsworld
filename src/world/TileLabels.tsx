import { useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import { FACES } from './faces'
import { AXIS_VEC, tileInSlice, type Axis } from './rotation'
import { usePlanet } from './store'
import type { Tile } from './tile'
import { COLS, ROWS, CELL, cellFace } from '../diorama/DioramaGrid'
import { HALF_W, HALF_H } from '../diorama/buildDiorama'

type Mode = 'grid' | 'split' | 'cube' | 'sphere'

const SPLIT_GAP = 0.12
const SPHERE_OUT = 1.06
const CUBE_OUT = 1.02
const FLAT_Y = 0.2
const FONT_SIZE_FLAT = 0.26
const FONT_SIZE_CUBE = 0.17
const FONT_SIZE_SPHERE = 0.17
const ROTATE_MS = 380

// Face identity — letter + per-face color. One letter per cube face (A..F)
// maps to FACES index 0..5. The index-within-face (1..4) runs u fastest,
// then v, so A1 = +X (u=0, v=0), A2 = +X (u=1, v=0), A3 = (u=0, v=1), A4 = (u=1, v=1).
const FACE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'] as const
const FACE_NAMES = ['+X', '-X', '+Y (top)', '-Y (bottom)', '+Z (front)', '-Z (back)'] as const
export const FACE_LABEL_COLORS = [
  '#9ec78a', // A  +X
  '#6fb3a8', // B  -X
  '#e8d8a8', // C  +Y
  '#8b6f47', // D  -Y
  '#c98a7a', // E  +Z
  '#7a8aa0', // F  -Z
] as const

function labelFor(face: number, u: number, v: number): string {
  const idx = v * 2 + u + 1
  return `${FACE_LETTERS[face]}${idx}`
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

function LabelText({
  text, fontSize, outline,
}: { text: string; fontSize: number; outline: string }) {
  return (
    <Text
      fontSize={fontSize}
      color="#1a1510"
      anchorX="center"
      anchorY="middle"
      outlineWidth={fontSize * 0.18}
      outlineColor={outline}
      fontWeight="bold"
    >
      {text}
    </Text>
  )
}

function FlatLabels({ split }: { split: boolean }) {
  const gap = split ? SPLIT_GAP : 0
  const nodes: React.ReactNode[] = []
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const face = cellFace(col, row)
      if (face < 0) continue
      const u = col % 2
      const v = row % 2
      const homeX = -HALF_W + (col + 0.5) * CELL
      const homeZ = -HALF_H + (row + 0.5) * CELL
      const gapX = split ? (col - (COLS - 1) / 2) * gap : 0
      const gapZ = split ? (row - (ROWS - 1) / 2) * gap : 0
      nodes.push(
        <Billboard key={`${col}-${row}`} position={[homeX + gapX, FLAT_Y, homeZ + gapZ]}>
          <LabelText
            text={labelFor(face, u, v)}
            fontSize={FONT_SIZE_FLAT}
            outline={FACE_LABEL_COLORS[face]}
          />
        </Billboard>,
      )
    }
  }
  return <>{nodes}</>
}

function CubeLabels() {
  const nodes: React.ReactNode[] = []
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const faceIdx = cellFace(col, row)
      if (faceIdx < 0) continue
      const face = FACES[faceIdx]
      const u = col % 2
      const v = row % 2
      const uOff = (u - 0.5) * CELL
      const vOff = (v - 0.5) * CELL
      const p = face.normal.clone()
        .addScaledVector(face.right, uOff)
        .addScaledVector(face.up, vOff)
        .addScaledVector(face.normal, CUBE_OUT - 1)
      nodes.push(
        <Billboard key={`${col}-${row}`} position={[p.x, p.y, p.z]}>
          <LabelText
            text={labelFor(faceIdx, u, v)}
            fontSize={FONT_SIZE_CUBE}
            outline={FACE_LABEL_COLORS[faceIdx]}
          />
        </Billboard>,
      )
    }
  }
  return <>{nodes}</>
}

function SphereLabels() {
  const tiles = usePlanet(s => s.tiles)
  const groupRefs = useRef<(THREE.Group | null)[]>([])
  const animStartRef = useRef<{ id: number; start: number } | null>(null)
  const _cube = useRef(new THREE.Vector3()).current
  const _q = useRef(new THREE.Quaternion()).current
  const _camDir = useRef(new THREE.Vector3()).current

  useFrame(({ clock, camera }) => {
    const state = usePlanet.getState()
    const { drag, anim } = state

    let activeAxis: Axis | null = null
    let activeSlice = 0
    let activeAngle = 0

    if (drag) {
      activeAxis = drag.axis
      activeSlice = drag.slice
      activeAngle = drag.angle
      animStartRef.current = null
    } else if (anim) {
      if (animStartRef.current?.id !== anim.id) {
        animStartRef.current = { id: anim.id, start: clock.elapsedTime }
      }
      const elapsed = clock.elapsedTime - animStartRef.current.start
      const t = Math.min(1, elapsed / (ROTATE_MS / 1000))
      activeAxis = anim.axis
      activeSlice = anim.slice
      activeAngle = anim.from + (anim.to - anim.from) * easeInOutCubic(t)
    } else {
      animStartRef.current = null
    }

    const useQuat = activeAxis !== null && activeAngle !== 0
    if (useQuat) _q.setFromAxisAngle(AXIS_VEC[activeAxis!], activeAngle)

    _camDir.copy(camera.position).normalize()

    for (let i = 0; i < tiles.length; i++) {
      const g = groupRefs.current[i]
      if (!g) continue
      const tile = tiles[i]
      const face = FACES[tile.face]
      const uOff = (tile.u - 0.5) * CELL
      const vOff = (tile.v - 0.5) * CELL
      _cube.copy(face.normal)
        .addScaledVector(face.right, uOff)
        .addScaledVector(face.up, vOff)

      if (useQuat && tileInSlice(tile, activeAxis!, activeSlice)) {
        _cube.applyQuaternion(_q)
      }

      _cube.normalize()
      const facing = _cube.dot(_camDir)
      const visible = facing > 0.05
      if (g.visible !== visible) g.visible = visible

      _cube.multiplyScalar(SPHERE_OUT)
      g.position.copy(_cube)
    }
  })

  return (
    <>
      {tiles.map((tile: Tile, i: number) => (
        <group key={tile.id} ref={el => { groupRefs.current[i] = el }}>
          <Billboard>
            <LabelText
              text={labelFor(tile.homeFace, tile.homeU, tile.homeV)}
              fontSize={FONT_SIZE_SPHERE}
              outline={FACE_LABEL_COLORS[tile.homeFace]}
            />
          </Billboard>
        </group>
      ))}
    </>
  )
}

export function TileLabelsLegend() {
  const show = usePlanet(s => s.showLabels)
  if (!show) return null
  return (
    <div style={{
      position: 'fixed',
      bottom: 12,
      right: 12,
      background: 'rgba(8, 10, 14, 0.85)',
      border: '1px solid #333',
      color: '#e0e0e0',
      padding: '10px 14px',
      borderRadius: 6,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 11,
      lineHeight: 1.5,
      pointerEvents: 'none',
      userSelect: 'none',
      zIndex: 100,
    }}>
      <div style={{ opacity: 0.55, marginBottom: 5, fontSize: 10 }}>TILE SET</div>
      {FACE_LETTERS.map((letter, i) => (
        <div key={letter} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            width: 10,
            height: 10,
            background: FACE_LABEL_COLORS[i],
            display: 'inline-block',
            borderRadius: 2,
            boxShadow: '0 0 0 1px #0008',
          }} />
          <span style={{ color: FACE_LABEL_COLORS[i], fontWeight: 700 }}>{letter}1–{letter}4</span>
          <span style={{ opacity: 0.55 }}>{FACE_NAMES[i]}</span>
        </div>
      ))}
    </div>
  )
}

export function TileLabels({ mode }: { mode: Mode }) {
  const show = usePlanet(s => s.showLabels)
  if (!show) return null
  if (mode === 'grid') return <FlatLabels split={false} />
  if (mode === 'split') return <FlatLabels split={true} />
  if (mode === 'cube') return <CubeLabels />
  return <SphereLabels />
}

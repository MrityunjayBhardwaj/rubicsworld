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
const CUBE_GAP = 0.06
const SPHERE_OUT = 1.04
const CUBE_OUT = 1.015
const FLAT_Y = 0.18
const FONT_SIZE_FLAT = 0.22
const FONT_SIZE_CUBE = 0.14
const FONT_SIZE_SPHERE = 0.14
const ROTATE_MS = 380

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

// Home tile ID that belongs at flat grid cell (col, row). Mirrors the
// enumeration order of buildSolvedTiles: face-first, then v, then u.
function homeIdForCell(col: number, row: number): number {
  const face = cellFace(col, row)
  const u = col % 2
  const v = row % 2
  return face * 4 + v * 2 + u
}

function LabelText({ text, fontSize }: { text: string; fontSize: number }) {
  return (
    <Text
      fontSize={fontSize}
      color="#1a1510"
      anchorX="center"
      anchorY="middle"
      outlineWidth={fontSize * 0.12}
      outlineColor="#fff0d8"
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
      const homeX = -HALF_W + (col + 0.5) * CELL
      const homeZ = -HALF_H + (row + 0.5) * CELL
      const gapX = split ? (col - (COLS - 1) / 2) * gap : 0
      const gapZ = split ? (row - (ROWS - 1) / 2) * gap : 0
      nodes.push(
        <Billboard key={`${col}-${row}`} position={[homeX + gapX, FLAT_Y, homeZ + gapZ]}>
          <LabelText text={String(homeIdForCell(col, row))} fontSize={FONT_SIZE_FLAT} />
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
      const face = FACES[cellFace(col, row)]
      const localU = col % 2
      const localV = row % 2
      const uOff = (localU - 0.5) * CELL
      const vOff = (localV - 0.5) * CELL
      const p = face.normal.clone()
        .addScaledVector(face.right, uOff)
        .addScaledVector(face.up, vOff)
        .addScaledVector(face.normal, CUBE_OUT - 1)
      nodes.push(
        <Billboard key={`${col}-${row}`} position={[p.x, p.y, p.z]}>
          <LabelText text={String(homeIdForCell(col, row))} fontSize={FONT_SIZE_CUBE} />
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
    if (useQuat) {
      _q.setFromAxisAngle(AXIS_VEC[activeAxis!], activeAngle)
    }

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
      // Hide labels on the back hemisphere so they don't read through the planet.
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
            <LabelText text={String(tile.id)} fontSize={FONT_SIZE_SPHERE} />
          </Billboard>
        </group>
      ))}
    </>
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

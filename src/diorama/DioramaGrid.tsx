/**
 * Cross cube-net flat layout. 8×6 bounding box, only 24 cells filled —
 * the 6 face-blocks arranged so every flat-adjacent pair of cells maps
 * to a real cube-edge-adjacent pair of cells (no opposite-face seams,
 * no cell-to-cell misalignment at face boundaries).
 *
 *     col:  0  1  2  3  4  5  6  7
 *   row 5:  .  .  C3 C4 .  .  .  .      +Y (top)
 *   row 4:  .  .  C1 C2 .  .  .  .
 *   row 3:  B3 B4 E3 E4 A3 A4 F3 F4     -X | +Z | +X | -Z
 *   row 2:  B1 B2 E1 E2 A1 A2 F1 F2
 *   row 1:  .  .  D3 D4 .  .  .  .      -Y (bottom)
 *   row 0:  .  .  D1 D2 .  .  .  .
 */

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { buildDiorama, HALF_W, HALF_H, type DioramaScene } from './buildDiorama'
import { useHdri } from '../world/hdriStore'

export const COLS = 8
export const ROWS = 6
export const CELL = 1.0

const FACE_COLORS = [
  '#9ec78a', // face 0
  '#6fb3a8', // face 1
  '#e8d8a8', // face 2
  '#8b6f47', // face 3
  '#c98a7a', // face 4
  '#7a8aa0', // face 5
]

/**
 * Returns the cube face index for a cell on the cross-net, or -1 if the
 * cell is outside the net (empty padding area).
 */
export function cellFace(col: number, row: number): number {
  // Middle row-pair: the four-face horizontal band B | E | A | F.
  if (row >= 2 && row <= 3) {
    const fbCol = Math.floor(col / 2)
    // fbCol 0 → B (-X = face 1)
    // fbCol 1 → E (+Z = face 4)
    // fbCol 2 → A (+X = face 0)
    // fbCol 3 → F (-Z = face 5)
    const BAND = [1, 4, 0, 5] as const
    return BAND[fbCol]
  }
  // Top row-pair: only cols 2-3 are filled (C = +Y).
  if (row >= 4 && row <= 5) {
    if (col >= 2 && col <= 3) return 2
    return -1
  }
  // Bottom row-pair: only cols 2-3 are filled (D = -Y).
  if (row >= 0 && row <= 1) {
    if (col >= 2 && col <= 3) return 3
    return -1
  }
  return -1
}

/** True if (col, row) is a real cell on the cube-net (not padding). */
export function isNetCell(col: number, row: number): boolean {
  return cellFace(col, row) >= 0
}

/**
 * For a cube face, return the top-left flat cell coordinates of its 2×2
 * block on the cross-net. (homeU, homeV) within the block are added to
 * get the actual cell: col = blockCol + homeU, row = blockRow + homeV.
 */
export const FACE_TO_BLOCK_TL: Record<number, readonly [number, number]> = {
  0: [4, 2], // A (+X)
  1: [0, 2], // B (-X)
  2: [2, 4], // C (+Y)
  3: [2, 0], // D (-Y)
  4: [2, 2], // E (+Z)
  5: [6, 2], // F (-Z)
} as const

function buildFlatGridLines(): THREE.Group {
  const g = new THREE.Group()
  const pts: number[] = []

  function line(x1: number, z1: number, x2: number, z2: number) {
    pts.push(x1, 0.015, z1, x2, 0.015, z2)
  }

  // Per-cell outline: draw the 4 edges of every filled cell. Duplicate
  // interior edges collapse visually into a single seam.
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (!isNetCell(col, row)) continue
      const x0 = -HALF_W + col * CELL
      const z0 = -HALF_H + row * CELL
      const x1 = x0 + CELL
      const z1 = z0 + CELL
      line(x0, z0, x1, z0)
      line(x1, z0, x1, z1)
      line(x1, z1, x0, z1)
      line(x0, z1, x0, z0)
    }
  }

  const lineGeo = new THREE.BufferGeometry()
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  g.add(new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({
    color: '#ff9933', transparent: true, opacity: 0.9,
  })))

  // Face-colored fills + center markers — only on filled cells.
  const markerGeo = new THREE.SphereGeometry(0.025, 6, 6)
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const face = cellFace(col, row)
      if (face < 0) continue
      const cx = -HALF_W + (col + 0.5) * CELL
      const cz = -HALF_H + (row + 0.5) * CELL

      const quad = new THREE.Mesh(
        new THREE.PlaneGeometry(CELL * 0.92, CELL * 0.92),
        new THREE.MeshBasicMaterial({
          color: FACE_COLORS[face],
          transparent: true,
          opacity: 0.12,
          side: THREE.DoubleSide,
        }),
      )
      quad.rotation.x = -Math.PI / 2
      quad.position.set(cx, 0.005, cz)
      g.add(quad)

      const marker = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({
        color: FACE_COLORS[face],
      }))
      marker.position.set(cx, 0.025, cz)
      g.add(marker)
    }
  }

  return g
}

export function DioramaGrid() {
  const groupRef = useRef<THREE.Group>(null)
  const dioramaRef = useRef<DioramaScene | null>(null)
  const ambientRef = useRef<THREE.AmbientLight | null>(null)
  const dirRef = useRef<THREE.DirectionalLight | null>(null)

  useEffect(() => {
    const parent = groupRef.current
    if (!parent) return

    const diorama = buildDiorama()
    dioramaRef.current = diorama
    parent.add(diorama.root)
    parent.add(buildFlatGridLines())

    const ambient = new THREE.AmbientLight(0xffffff, 0.5)
    parent.add(ambient)
    ambientRef.current = ambient
    const dir = new THREE.DirectionalLight(0xffffff, 1.2)
    dir.position.set(3, 4, 2)
    parent.add(dir)
    dirRef.current = dir

    return () => {
      while (parent.children.length) parent.remove(parent.children[0])
    }
  }, [])

  useFrame(({ clock }) => {
    dioramaRef.current?.update(clock.elapsedTime)
    const physicalLights = useHdri.getState().physicalLights
    if (ambientRef.current) ambientRef.current.intensity = physicalLights ? 0.5 : 0
    if (dirRef.current) dirRef.current.intensity = physicalLights ? 1.2 : 0
  })

  return <group ref={groupRef} />
}

/**
 * Grid overlay view: flat diorama with 4×6 = 24 square-cell grid.
 * Each cell = 0.5 × 0.5. Base = 2 wide × 3 deep.
 *
 * Face assignment (2×2 blocks → 6 faces):
 *   col:  0  1 | 2  3
 *   row5: [f5] | [f0]    (top block-row)
 *   row4: [f5] | [f0]
 *   row3: [f4] | [f3]    (middle block-row)
 *   row2: [f4] | [f3]
 *   row1: [f2] | [f1]    (bottom block-row)
 *   row0: [f2] | [f1]
 */

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { buildDiorama, HALF_W, HALF_H, type DioramaScene } from './buildDiorama'

export const COLS = 4
export const ROWS = 6
export const CELL = 1.0  // BASE_W / COLS = BASE_H / ROWS = 1.0

const FACE_COLORS = [
  '#9ec78a', // face 0
  '#6fb3a8', // face 1
  '#e8d8a8', // face 2
  '#8b6f47', // face 3
  '#c98a7a', // face 4
  '#7a8aa0', // face 5
]

export function cellFace(col: number, row: number): number {
  const fbCol = Math.floor(col / 2) // 0 or 1
  const fbRow = Math.floor(row / 2) // 0, 1, or 2
  // Layout:
  //   fbRow=2: [f5, f0]
  //   fbRow=1: [f4, f3]
  //   fbRow=0: [f2, f1]
  const map = [
    [2, 1], // fbRow=0
    [4, 3], // fbRow=1
    [5, 0], // fbRow=2
  ]
  return map[fbRow][fbCol]
}

function buildFlatGridLines(): THREE.Group {
  const g = new THREE.Group()
  const pts: number[] = []

  function line(x1: number, z1: number, x2: number, z2: number) {
    pts.push(x1, 0.015, z1, x2, 0.015, z2)
  }

  // Outer boundary
  line(-HALF_W, -HALF_H, HALF_W, -HALF_H)
  line(HALF_W, -HALF_H, HALF_W, HALF_H)
  line(HALF_W, HALF_H, -HALF_W, HALF_H)
  line(-HALF_W, HALF_H, -HALF_W, -HALF_H)

  // Column dividers
  for (let c = 1; c < COLS; c++) {
    const x = -HALF_W + c * CELL
    line(x, -HALF_H, x, HALF_H)
  }
  // Row dividers
  for (let r = 1; r < ROWS; r++) {
    const z = -HALF_H + r * CELL
    line(-HALF_W, z, HALF_W, z)
  }

  const lineGeo = new THREE.BufferGeometry()
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  g.add(new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({
    color: '#ff9933', transparent: true, opacity: 0.9,
  })))

  // Face-colored fills + center markers
  const markerGeo = new THREE.SphereGeometry(0.025, 6, 6)
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const face = cellFace(col, row)
      const cx = -HALF_W + (col + 0.5) * CELL
      const cz = -HALF_H + (row + 0.5) * CELL

      // Tinted fill
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

      // Center marker
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

  useEffect(() => {
    const parent = groupRef.current
    if (!parent) return

    const diorama = buildDiorama()
    dioramaRef.current = diorama
    parent.add(diorama.root)
    parent.add(buildFlatGridLines())

    // Lights
    parent.add(new THREE.AmbientLight(0xffffff, 0.5))
    const dir = new THREE.DirectionalLight(0xffffff, 1.2)
    dir.position.set(3, 4, 2)
    parent.add(dir)

    return () => {
      while (parent.children.length) parent.remove(parent.children[0])
    }
  }, [])

  useFrame(({ clock }) => {
    dioramaRef.current?.update(clock.elapsedTime)
  })

  return <group ref={groupRef} />
}

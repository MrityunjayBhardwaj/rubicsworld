// CPU mirror of the GPU sphere-projection vertex shader (patchMaterialForSphere
// in TileGrid.tsx). The diorama is authored as a flat 4×6 cube-net in dScene;
// the GPU folds and inflates it into the visible sphere at render time. The
// CPU never sees the sphere coords — meshes' world position is still flat.
//
// PositionalAudio computes distance between listener (in main-scene world space,
// orbiting the planet) and anchor (in cube-net flat space). Without a CPU
// projection, those are coordinates in unrelated spaces — distance crosses the
// radius threshold chaotically as orbit sweeps through cube-net XZ extent →
// gain thrashes → "chop inside zones." This file projects flat → sphere so the
// audio anchor's world position matches what the user sees.
//
// Limitations:
//   - Skips the bezier height curve (linear height — close enough for audio
//     positioning; the user can't hear the curve).
//   - Skips slice-rotation handling (during active drag/anim, anchors on
//     rotating tiles will lag a frame or two — slice rotations are short).

import * as THREE from 'three'
import { COLS, ROWS, CELL, FACE_TO_BLOCK_TL, cellFace } from '../../diorama/DioramaGrid'
import { HALF_W, HALF_H } from '../../diorama/buildDiorama'
import { FACES } from '../faces'
import { usePlanet } from '../store'

const _vUp = new THREE.Vector3(0, 1, 0)
const _vRight = new THREE.Vector3(1, 0, 0)
const _q1 = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()
const _v1 = new THREE.Vector3()

// Mirrors the private faceQuaternion in TileGrid.tsx — rotates the flat
// (Y-up, X-right) authoring frame onto the cube face's (normal-up, right-right)
// frame.
function computeFaceQuaternion(face: typeof FACES[number], out: THREE.Quaternion): THREE.Quaternion {
  out.setFromUnitVectors(_vUp, face.normal)
  _v1.copy(_vRight).applyQuaternion(out)
  const cross = _v1.clone().cross(face.right)
  const angle = Math.atan2(cross.dot(face.normal), _v1.dot(face.right))
  _q2.setFromAxisAngle(face.normal, angle)
  return out.premultiply(_q2)
}

const _localOffset = new THREE.Vector3()
const _cubePos = new THREE.Vector3()
const _faceQuatScratch = new THREE.Quaternion()

/**
 * Project a position from dScene-local cube-net space to the sphere surface.
 * Returns false if the input falls outside any cube-net cell.
 */
export function cubeNetToSphere(flatPos: THREE.Vector3, out: THREE.Vector3): boolean {
  const col = Math.floor((flatPos.x + HALF_W) / CELL)
  const row = Math.floor((flatPos.z + HALF_H) / CELL)
  if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return false
  const homeFace = cellFace(col, row)
  if (homeFace < 0) return false
  const [blockCol, blockRow] = FACE_TO_BLOCK_TL[homeFace]
  const homeU = col - blockCol
  const homeV = row - blockRow

  const tiles = usePlanet.getState().tiles
  const tile = tiles.find(t => t.homeFace === homeFace && t.homeU === homeU && t.homeV === homeV)
  if (!tile) return false

  const homeCenterX = -HALF_W + (col + 0.5) * CELL
  const homeCenterZ = -HALF_H + (row + 0.5) * CELL
  const currentFace = FACES[tile.face]

  // Tile centre on cube face (matches storeTileCubeRender's cubePos).
  const uOff = (tile.u - 0.5) * CELL
  const vOff = (0.5 - tile.v) * CELL
  _cubePos.copy(currentFace.normal)
    .addScaledVector(currentFace.right, uOff)
    .addScaledVector(currentFace.up, vOff)

  // Tile orientation = tile.orientation · faceQuaternion(homeFace). Same
  // composition the render loop uses; uses homeFace because faceQuaternion
  // orients the home content for that home face, then orientation rotates
  // it into the current face's slot.
  computeFaceQuaternion(FACES[tile.homeFace], _faceQuatScratch)
  _faceQuatScratch.premultiply(tile.orientation)

  // Anchor offset within the tile (dScene-local relative to home centre).
  _localOffset.set(
    flatPos.x - homeCenterX,
    flatPos.y,
    flatPos.z - homeCenterZ,
  )
  _localOffset.applyQuaternion(_faceQuatScratch)

  // Cube-space world pos = tile centre + rotated local offset.
  const wpX = _cubePos.x + _localOffset.x
  const wpY = _cubePos.y + _localOffset.y
  const wpZ = _cubePos.z + _localOffset.z

  // Sphere projection (linear height, no bezier).
  const fn = currentFace.normal
  const faceDistance = wpX * fn.x + wpY * fn.y + wpZ * fn.z
  const rawHeight = faceDistance - 1.0

  const bpX = wpX - rawHeight * fn.x
  const bpY = wpY - rawHeight * fn.y
  const bpZ = wpZ - rawHeight * fn.z
  const len = Math.sqrt(bpX * bpX + bpY * bpY + bpZ * bpZ)
  if (len < 1e-6) return false
  const scale = (1 + Math.max(0, rawHeight)) / len
  out.set(bpX * scale, bpY * scale, bpZ * scale)
  // Reuse the unused _q1 to avoid the unused-binding warning in some builds.
  void _q1
  return true
}

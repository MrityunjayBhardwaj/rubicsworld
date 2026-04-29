import { Vector3 } from 'three'

export type FaceIndex = 0 | 1 | 2 | 3 | 4 | 5

export interface FaceDef {
  index: FaceIndex
  normal: Vector3
  right: Vector3
  up: Vector3
  color: string
}

// right × up = outward normal (right-handed). Verified by hand.
//
// Faces 2 (C) and 3 (D) carry an applied basis rotation relative to the
// natural +Y/-Y orientation. The composition is:
//   1. World-Z 180° on the C+D pair → swaps positions (C at -Y, D at +Y)
//      and flips each face's right/up X components.
//   2. World-Y 180° on each face individually → in-place 180° twist about
//      each face's normal (positions unchanged because the normal is along Y).
// Net effect = world-X 180° on the original C+D pair: C content (flat-net
// rows 4-5) renders at the -Y cube slot; D content (rows 0-1) at +Y; each
// face's local up has its Z component flipped vs. the natural orientation.
// All consumers that read face.normal/right/up (cube projection, slice
// rotation, audio anchors, labels) inherit the rotation automatically.
export const FACES: readonly FaceDef[] = [
  { index: 0, normal: new Vector3( 1, 0, 0), right: new Vector3( 0, 0,-1), up: new Vector3(0, 1, 0), color: '#9ec78a' },
  { index: 1, normal: new Vector3(-1, 0, 0), right: new Vector3( 0, 0, 1), up: new Vector3(0, 1, 0), color: '#6fb3a8' },
  { index: 2, normal: new Vector3( 0,-1, 0), right: new Vector3( 1, 0, 0), up: new Vector3(0, 0, 1), color: '#e8d8a8' },
  { index: 3, normal: new Vector3( 0, 1, 0), right: new Vector3( 1, 0, 0), up: new Vector3(0, 0,-1), color: '#8b6f47' },
  { index: 4, normal: new Vector3( 0, 0, 1), right: new Vector3( 1, 0, 0), up: new Vector3(0, 1, 0), color: '#c98a7a' },
  { index: 5, normal: new Vector3( 0, 0,-1), right: new Vector3(-1, 0, 0), up: new Vector3(0, 1, 0), color: '#7a8aa0' },
] as const

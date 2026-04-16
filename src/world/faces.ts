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
export const FACES: readonly FaceDef[] = [
  { index: 0, normal: new Vector3( 1, 0, 0), right: new Vector3(0, 0,-1), up: new Vector3(0, 1, 0), color: '#9ec78a' },
  { index: 1, normal: new Vector3(-1, 0, 0), right: new Vector3(0, 0, 1), up: new Vector3(0, 1, 0), color: '#6fb3a8' },
  { index: 2, normal: new Vector3( 0, 1, 0), right: new Vector3(1, 0, 0), up: new Vector3(0, 0,-1), color: '#e8d8a8' },
  { index: 3, normal: new Vector3( 0,-1, 0), right: new Vector3(1, 0, 0), up: new Vector3(0, 0, 1), color: '#8b6f47' },
  { index: 4, normal: new Vector3( 0, 0, 1), right: new Vector3(1, 0, 0), up: new Vector3(0, 1, 0), color: '#c98a7a' },
  { index: 5, normal: new Vector3( 0, 0,-1), right: new Vector3(-1,0, 0), up: new Vector3(0, 1, 0), color: '#7a8aa0' },
] as const

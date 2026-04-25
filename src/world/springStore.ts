import * as THREE from 'three'

/**
 * Damped-spring 1D state, integrated as semi-implicit Euler.
 *
 *   a = -k * x - c * v + driving
 *   v += a * dt
 *   x += v * dt
 *
 * `driving` is set externally each frame (e.g. from camera angular
 * velocity). When driving drops to 0, x ringtones back via the
 * stored momentum in v — that's the "recoil and settle" the user
 * sees on commit.
 *
 * x lives in world-ish units (radians of bend at peak height).
 * Underdamped at k=120, c=8 → ~0.6s settle.
 */

interface SpringState {
  x: THREE.Vector3
  v: THREE.Vector3
  driving: THREE.Vector3
  k: number
  c: number
}

export const spring: SpringState = {
  x: new THREE.Vector3(),
  v: new THREE.Vector3(),
  driving: new THREE.Vector3(),
  k: 120,
  c: 8,
}

const _accel = new THREE.Vector3()
const _damp = new THREE.Vector3()

export function stepSpring(dt: number): void {
  const clampedDt = Math.min(dt, 1 / 30) // avoid integration blow-up after tab switch
  _accel.copy(spring.x).multiplyScalar(-spring.k)
  _damp.copy(spring.v).multiplyScalar(-spring.c)
  _accel.add(_damp).add(spring.driving)
  spring.v.addScaledVector(_accel, clampedDt)
  spring.x.addScaledVector(spring.v, clampedDt)
}

export function setSpringDriving(force: THREE.Vector3): void {
  spring.driving.copy(force)
}

export function setSpringTuning(k: number, c: number): void {
  spring.k = k
  spring.c = c
}

export function resetSpring(): void {
  spring.x.set(0, 0, 0)
  spring.v.set(0, 0, 0)
  spring.driving.set(0, 0, 0)
}

export function getSpringImpulse(): THREE.Vector3 {
  return spring.x
}

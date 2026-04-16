import { useSpring, animated, easings } from '@react-spring/three'
import { usePlanet } from './store'
import type { Axis } from './rotation'

const AXIS_TUPLE: Record<Axis, [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
}

// Torus's natural axis is +Z. Rotate the inner group so its axis
// aligns with the ring axis.
const INNER_ROT: Record<Axis, [number, number, number]> = {
  x: [0, Math.PI / 2, 0],
  y: [Math.PI / 2, 0, 0],
  z: [0, 0, 0],
}

export function Ring() {
  const ring = usePlanet(s => s.ring)
  const drag = usePlanet(s => s.drag)
  const anim = usePlanet(s => s.anim)

  const axisTuple = AXIS_TUPLE[ring.axis]
  const offset = ring.slice === 0 ? -0.5 : 0.5
  const targetPos: [number, number, number] = [
    axisTuple[0] * offset,
    axisTuple[1] * offset,
    axisTuple[2] * offset,
  ]
  const targetInnerRot = INNER_ROT[ring.axis]

  // Axis/slice transitions are tweened so the ring glides rather than pops.
  const { position, innerRot } = useSpring({
    position: targetPos,
    innerRot: targetInnerRot,
    config: { duration: 220, easing: easings.easeInOutCubic },
  })

  // During drag or anim whose slice matches the ring's current selection,
  // the ring spins around its axis with the slice. Programmatic anims
  // (scramble) on OTHER slices leave the ring alone.
  const active = drag ?? anim
  const matches = active && active.axis === ring.axis && active.slice === ring.slice
  let spinAngle = 0
  if (matches) {
    if (drag) spinAngle = drag.angle
    // For anim we don't know current spring value here — let the tiles
    // carry the visual during commit. Ring stays at 0 (or at drag.angle
    // handed off until commit). Simpler + accurate enough.
  }
  const outerRot: [number, number, number] = [
    axisTuple[0] * spinAngle,
    axisTuple[1] * spinAngle,
    axisTuple[2] * spinAngle,
  ]

  const emissiveIntensity = matches ? 0.85 : 0.45
  const color = ring.slice === 0 ? '#f3d7a3' : '#f7c77c'

  return (
    <group rotation={outerRot}>
      <animated.group position={position as unknown as [number, number, number]} rotation={innerRot as unknown as [number, number, number]}>
        <mesh>
          <torusGeometry args={[1.35, 0.04, 24, 160]} />
          <meshStandardMaterial
            color={color}
            emissive="#ffb56b"
            emissiveIntensity={emissiveIntensity}
            metalness={0.55}
            roughness={0.35}
          />
        </mesh>
      </animated.group>
    </group>
  )
}

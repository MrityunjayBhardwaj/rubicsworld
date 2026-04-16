import { useSpring, animated, easings } from '@react-spring/three'
import { usePlanet } from './store'
import type { Axis } from './rotation'

const AXIS_TUPLE: Record<Axis, [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
}

const INNER_ROT: Record<Axis, [number, number, number]> = {
  x: [0, Math.PI / 2, 0],
  y: [Math.PI / 2, 0, 0],
  z: [0, 0, 0],
}

export function Ring() {
  const showRing = usePlanet(s => s.showRing)
  if (!showRing) return null
  return <RingMesh />
}

function RingMesh() {
  const drag = usePlanet(s => s.drag)
  const anim = usePlanet(s => s.anim)

  const active = drag ?? anim
  // Pick a persistent fallback so the ring can continue animating its
  // opacity to 0 after active becomes null, without the position
  // snapping to a default.
  const axis: Axis = active?.axis ?? 'y'
  const slice = active?.slice ?? 0

  const axisTuple = AXIS_TUPLE[axis]
  const offset = slice === 0 ? -0.5 : 0.5
  const targetPos: [number, number, number] = [
    axisTuple[0] * offset,
    axisTuple[1] * offset,
    axisTuple[2] * offset,
  ]
  const targetInnerRot = INNER_ROT[axis]

  const { position, innerRot, opacity } = useSpring({
    position: targetPos,
    innerRot: targetInnerRot,
    opacity: active ? 1 : 0,
    config: { duration: 160, easing: easings.easeInOutCubic },
  })

  const spinAngle = drag ? drag.angle : 0
  const outerRot: [number, number, number] = [
    axisTuple[0] * spinAngle,
    axisTuple[1] * spinAngle,
    axisTuple[2] * spinAngle,
  ]

  return (
    <group rotation={outerRot}>
      <animated.group
        position={position as unknown as [number, number, number]}
        rotation={innerRot as unknown as [number, number, number]}
      >
        <mesh>
          <torusGeometry args={[1.35, 0.04, 24, 160]} />
          <animated.meshStandardMaterial
            color="#f3d7a3"
            emissive="#ffb56b"
            emissiveIntensity={0.8}
            metalness={0.55}
            roughness={0.35}
            transparent
            opacity={opacity}
            depthWrite={false}
          />
        </mesh>
      </animated.group>
    </group>
  )
}

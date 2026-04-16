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
  const onPlanet = usePlanet(s => s.onPlanet)

  const axisTuple = AXIS_TUPLE[ring.axis]
  const offset = ring.slice === 0 ? -0.5 : 0.5
  const targetPos: [number, number, number] = [
    axisTuple[0] * offset,
    axisTuple[1] * offset,
    axisTuple[2] * offset,
  ]
  const targetInnerRot = INNER_ROT[ring.axis]

  // Keep the ring present while anything active is happening — a
  // committing spring mid-rotation or an in-progress drag — even if
  // the cursor has strayed off the planet mid-gesture.
  const shouldShow = onPlanet || !!drag || !!anim

  const { position, innerRot, opacity } = useSpring({
    position: targetPos,
    innerRot: targetInnerRot,
    opacity: shouldShow ? 1 : 0,
    config: { duration: 180, easing: easings.easeInOutCubic },
  })

  const active = drag ?? anim
  const matches = active && active.axis === ring.axis && active.slice === ring.slice
  const spinAngle = matches && drag ? drag.angle : 0
  const outerRot: [number, number, number] = [
    axisTuple[0] * spinAngle,
    axisTuple[1] * spinAngle,
    axisTuple[2] * spinAngle,
  ]

  const emissiveIntensity = matches ? 0.85 : 0.45
  const color = ring.slice === 0 ? '#f3d7a3' : '#f7c77c'

  return (
    <group rotation={outerRot}>
      <animated.group
        position={position as unknown as [number, number, number]}
        rotation={innerRot as unknown as [number, number, number]}
      >
        <mesh visible={shouldShow || opacity.get() > 0.01}>
          <torusGeometry args={[1.35, 0.04, 24, 160]} />
          <animated.meshStandardMaterial
            color={color}
            emissive="#ffb56b"
            emissiveIntensity={emissiveIntensity}
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

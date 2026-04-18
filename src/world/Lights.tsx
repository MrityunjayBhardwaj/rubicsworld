import { useSpring, animated } from '@react-spring/three'
import { usePlanet } from './store'

const COOL = {
  directionalColor: '#cfd8e3',
  directionalIntensity: 1.1,
  ambientIntensity: 0.35,
}

const WARM = {
  directionalColor: '#ffd9a8',
  directionalIntensity: 1.45,
  ambientIntensity: 0.55,
}

export function Lights() {
  const solved = usePlanet(s => s.solved)

  const { directionalColor, directionalIntensity, ambientIntensity } = useSpring({
    directionalColor: solved ? WARM.directionalColor : COOL.directionalColor,
    directionalIntensity: solved ? WARM.directionalIntensity : COOL.directionalIntensity,
    ambientIntensity: solved ? WARM.ambientIntensity : COOL.ambientIntensity,
    config: { duration: 2000 },
  })

  return (
    <>
      <animated.ambientLight intensity={ambientIntensity} />
      <animated.directionalLight
        position={[4, 5, 3]}
        color={directionalColor}
        intensity={directionalIntensity}
      />
    </>
  )
}

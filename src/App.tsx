import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { CubeSphere } from './world/CubeSphere'
import { Ring } from './world/Ring'
import { Interaction } from './world/Interaction'
import { Controls } from './Controls'
import { usePlanet } from './world/store'

if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__planet = usePlanet
}

function Cursor() {
  const onPlanet = usePlanet(s => s.onPlanet)
  const drag = usePlanet(s => s.drag)
  const cursor = drag ? 'grabbing' : onPlanet ? 'grab' : 'default'
  return (
    <style>{`canvas { cursor: ${cursor}; }`}</style>
  )
}

export default function App() {
  return (
    <>
      <Controls />
      <Cursor />
      <Canvas
        camera={{ position: [2.4, 1.6, 2.8], fov: 45 }}
        gl={{ antialias: true }}
        dpr={[1, 2]}
      >
        <color attach="background" args={['#0a0d12']} />
        <ambientLight intensity={0.35} />
        <directionalLight position={[4, 5, 3]} intensity={1.1} />
        <CubeSphere />
        <Ring />
        <Interaction />
        <OrbitControls
          enablePan={false}
          mouseButtons={{
            LEFT: THREE.MOUSE.ROTATE,
            MIDDLE: THREE.MOUSE.DOLLY,
            RIGHT: THREE.MOUSE.ROTATE,
          }}
          minDistance={2.5}
          maxDistance={8}
        />
      </Canvas>
    </>
  )
}

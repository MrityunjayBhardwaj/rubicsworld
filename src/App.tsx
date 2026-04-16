import { Canvas } from '@react-three/fiber'
import { CubeSphere } from './world/CubeSphere'
import { Ring } from './world/Ring'
import { Controls } from './Controls'
import { InputHandler } from './InputHandler'

export default function App() {
  return (
    <>
      <Controls />
      <InputHandler />
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
      </Canvas>
    </>
  )
}

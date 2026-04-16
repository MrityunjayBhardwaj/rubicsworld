import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { CubeSphere } from './world/CubeSphere'
import { Controls } from './Controls'

export default function App() {
  return (
    <>
      <Controls />
      <Canvas
        camera={{ position: [2.4, 1.6, 2.8], fov: 45 }}
        gl={{ antialias: true }}
        dpr={[1, 2]}
      >
        <color attach="background" args={['#0a0d12']} />
        <ambientLight intensity={0.35} />
        <directionalLight position={[4, 5, 3]} intensity={1.1} />
        <CubeSphere />
        <OrbitControls enablePan={false} />
      </Canvas>
    </>
  )
}

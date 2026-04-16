import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'

function Planet() {
  return (
    <mesh>
      <sphereGeometry args={[1, 64, 64]} />
      <meshStandardMaterial color="#9ec78a" roughness={0.85} />
    </mesh>
  )
}

export default function App() {
  return (
    <Canvas
      camera={{ position: [0, 0.6, 3.2], fov: 45 }}
      gl={{ antialias: true }}
      dpr={[1, 2]}
    >
      <color attach="background" args={['#0a0d12']} />
      <ambientLight intensity={0.25} />
      <directionalLight position={[4, 5, 3]} intensity={1.1} />
      <Planet />
      <OrbitControls enablePan={false} />
    </Canvas>
  )
}

import { useMemo } from 'react'
import { buildAllTileGeometries } from './tileGeometry'

export function CubeSphere() {
  const tiles = useMemo(() => buildAllTileGeometries(), [])
  return (
    <group>
      {tiles.map((t, i) => (
        <mesh key={i} geometry={t.geometry}>
          <meshStandardMaterial color={t.color} roughness={0.7} metalness={0.05} />
        </mesh>
      ))}
    </group>
  )
}

import { useMemo } from 'react'
import { useSpring, animated, easings } from '@react-spring/three'
import { buildAllTileGeometries, type TileMeshDef } from './tileGeometry'
import { usePlanet, type ActiveRotation } from './store'
import { tileInSlice, type Axis } from './rotation'
import type { Tile } from './tile'

const ROTATE_MS = 400

const AXIS_TUPLE: Record<Axis, [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
}

function TileMesh({ tile, geom }: { tile: Tile; geom: TileMeshDef }) {
  const q: [number, number, number, number] = [
    tile.orientation.x,
    tile.orientation.y,
    tile.orientation.z,
    tile.orientation.w,
  ]
  return (
    <mesh geometry={geom.geometry} quaternion={q}>
      <meshStandardMaterial color={geom.color} roughness={0.7} metalness={0.05} />
    </mesh>
  )
}

function ActiveSlice({
  tiles,
  geoms,
  active,
  onDone,
}: {
  tiles: readonly Tile[]
  geoms: TileMeshDef[]
  active: ActiveRotation
  onDone: () => void
}) {
  const targetAngle = (active.dir * Math.PI) / 2
  const axisTuple = AXIS_TUPLE[active.axis]

  const { rot } = useSpring({
    from: { rot: 0 },
    to: { rot: targetAngle },
    config: { duration: ROTATE_MS, easing: easings.easeInOutCubic },
    onRest: onDone,
  })

  const slicedIds = useMemo(() => {
    const set = new Set<number>()
    for (const t of tiles) {
      if (tileInSlice(t, active.axis, active.slice)) set.add(t.id)
    }
    return set
  }, [tiles, active.axis, active.slice])

  return (
    <>
      {tiles.map(t => {
        const g = geoms[t.id]
        if (!slicedIds.has(t.id)) return <TileMesh key={t.id} tile={t} geom={g} />
        return (
          <animated.group
            key={t.id}
            rotation-x={rot.to(r => axisTuple[0] * r)}
            rotation-y={rot.to(r => axisTuple[1] * r)}
            rotation-z={rot.to(r => axisTuple[2] * r)}
          >
            <TileMesh tile={t} geom={g} />
          </animated.group>
        )
      })}
    </>
  )
}

export function CubeSphere() {
  const geoms = useMemo(() => buildAllTileGeometries(), [])
  const tiles = usePlanet(s => s.tiles)
  const active = usePlanet(s => s.active)
  const commit = usePlanet(s => s.commitActive)

  return (
    <group>
      {active ? (
        <ActiveSlice
          key={active.id}
          tiles={tiles}
          geoms={geoms}
          active={active}
          onDone={commit}
        />
      ) : (
        tiles.map(t => <TileMesh key={t.id} tile={t} geom={geoms[t.id]} />)
      )}
    </group>
  )
}

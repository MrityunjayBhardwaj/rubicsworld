import { useMemo } from 'react'
import { useSpring, animated, easings } from '@react-spring/three'
import { buildAllTileGeometries, type TileMeshDef } from './tileGeometry'
import { usePlanet, type AnimState, type DragState } from './store'
import { tileInSlice, type Axis } from './rotation'
import type { Tile } from './tile'

const ROTATE_MS = 380

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

function useSlicedIds(tiles: readonly Tile[], axis: Axis, slice: number) {
  return useMemo(() => {
    const set = new Set<number>()
    for (const t of tiles) if (tileInSlice(t, axis, slice)) set.add(t.id)
    return set
  }, [tiles, axis, slice])
}

function StaticPlanet({ tiles, geoms }: { tiles: readonly Tile[]; geoms: TileMeshDef[] }) {
  return (
    <>
      {tiles.map(t => (
        <TileMesh key={t.id} tile={t} geom={geoms[t.id]} />
      ))}
    </>
  )
}

function AnimSlice({
  tiles,
  geoms,
  anim,
  onRest,
}: {
  tiles: readonly Tile[]
  geoms: TileMeshDef[]
  anim: AnimState
  onRest: () => void
}) {
  const axisTuple = AXIS_TUPLE[anim.axis]
  const { rot } = useSpring({
    from: { rot: anim.from },
    to: { rot: anim.to },
    config: { duration: ROTATE_MS, easing: easings.easeInOutCubic },
    onRest,
  })
  const slicedIds = useSlicedIds(tiles, anim.axis, anim.slice)

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

function DragSlice({
  tiles,
  geoms,
  drag,
}: {
  tiles: readonly Tile[]
  geoms: TileMeshDef[]
  drag: DragState
}) {
  const axisTuple = AXIS_TUPLE[drag.axis]
  const r = drag.angle
  const rot: [number, number, number] = [axisTuple[0] * r, axisTuple[1] * r, axisTuple[2] * r]
  const slicedIds = useSlicedIds(tiles, drag.axis, drag.slice)

  return (
    <>
      {tiles.map(t => {
        const g = geoms[t.id]
        if (!slicedIds.has(t.id)) return <TileMesh key={t.id} tile={t} geom={g} />
        return (
          <group key={t.id} rotation={rot}>
            <TileMesh tile={t} geom={g} />
          </group>
        )
      })}
    </>
  )
}

export function CubeSphere() {
  const geoms = useMemo(() => buildAllTileGeometries(), [])
  const tiles = usePlanet(s => s.tiles)
  const anim = usePlanet(s => s.anim)
  const drag = usePlanet(s => s.drag)
  const finishAnim = usePlanet(s => s._finishAnim)

  return (
    <group>
      {anim ? (
        <AnimSlice key={anim.id} tiles={tiles} geoms={geoms} anim={anim} onRest={finishAnim} />
      ) : drag ? (
        <DragSlice tiles={tiles} geoms={geoms} drag={drag} />
      ) : (
        <StaticPlanet tiles={tiles} geoms={geoms} />
      )}
    </group>
  )
}

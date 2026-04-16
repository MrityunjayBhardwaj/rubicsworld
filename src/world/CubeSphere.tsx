import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useSpring, animated, easings } from '@react-spring/three'
import { Billboard, Text } from '@react-three/drei'
import { buildAllTileGeometries, type TileMeshDef } from './tileGeometry'
import { usePlanet, type AnimState, type DragState } from './store'
import { tileInSlice, tileCentroid, type Axis } from './rotation'
import type { Tile } from './tile'

const _labelWp = new THREE.Vector3()
const _tileDir = new THREE.Vector3()
const _camDir = new THREE.Vector3()

const ROTATE_MS = 380

const AXIS_TUPLE: Record<Axis, [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
}

function TileLabel({ homePos, id }: { homePos: THREE.Vector3; id: number }) {
  const ref = useRef<THREE.Group>(null)
  const { camera } = useThree()
  useFrame(() => {
    const g = ref.current
    if (!g) return
    g.getWorldPosition(_labelWp)
    _tileDir.copy(_labelWp).normalize()
    _camDir.copy(camera.position).normalize()
    const visible = _tileDir.dot(_camDir) > 0.1
    if (g.visible !== visible) g.visible = visible
  })
  return (
    <group ref={ref} position={[homePos.x * 1.04, homePos.y * 1.04, homePos.z * 1.04]}>
      <Billboard>
        <Text
          fontSize={0.12}
          color="#1a1510"
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.012}
          outlineColor="#fff0d8"
        >
          {id}
        </Text>
      </Billboard>
    </group>
  )
}

function TileMesh({
  tile,
  geom,
  showLabel,
}: {
  tile: Tile
  geom: TileMeshDef
  showLabel: boolean
}) {
  const q: [number, number, number, number] = [
    tile.orientation.x,
    tile.orientation.y,
    tile.orientation.z,
    tile.orientation.w,
  ]
  const home = useMemo(
    () => tileCentroid(tile.homeFace, tile.homeU, tile.homeV),
    [tile.homeFace, tile.homeU, tile.homeV],
  )
  return (
    <group quaternion={q}>
      <mesh geometry={geom.geometry}>
        <meshStandardMaterial color={geom.color} roughness={0.7} metalness={0.05} />
      </mesh>
      {showLabel && <TileLabel homePos={home} id={tile.id} />}
    </group>
  )
}

function useSlicedIds(tiles: readonly Tile[], axis: Axis, slice: number) {
  return useMemo(() => {
    const set = new Set<number>()
    for (const t of tiles) if (tileInSlice(t, axis, slice)) set.add(t.id)
    return set
  }, [tiles, axis, slice])
}

function StaticPlanet({
  tiles,
  geoms,
  showLabels,
}: {
  tiles: readonly Tile[]
  geoms: TileMeshDef[]
  showLabels: boolean
}) {
  return (
    <>
      {tiles.map(t => (
        <TileMesh key={t.id} tile={t} geom={geoms[t.id]} showLabel={showLabels} />
      ))}
    </>
  )
}

function AnimSlice({
  tiles,
  geoms,
  anim,
  onRest,
  showLabels,
}: {
  tiles: readonly Tile[]
  geoms: TileMeshDef[]
  anim: AnimState
  onRest: () => void
  showLabels: boolean
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
        if (!slicedIds.has(t.id))
          return <TileMesh key={t.id} tile={t} geom={g} showLabel={showLabels} />
        return (
          <animated.group
            key={t.id}
            rotation-x={rot.to(r => axisTuple[0] * r)}
            rotation-y={rot.to(r => axisTuple[1] * r)}
            rotation-z={rot.to(r => axisTuple[2] * r)}
          >
            <TileMesh tile={t} geom={g} showLabel={showLabels} />
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
  showLabels,
}: {
  tiles: readonly Tile[]
  geoms: TileMeshDef[]
  drag: DragState
  showLabels: boolean
}) {
  const axisTuple = AXIS_TUPLE[drag.axis]
  const r = drag.angle
  const rot: [number, number, number] = [axisTuple[0] * r, axisTuple[1] * r, axisTuple[2] * r]
  const slicedIds = useSlicedIds(tiles, drag.axis, drag.slice)

  return (
    <>
      {tiles.map(t => {
        const g = geoms[t.id]
        if (!slicedIds.has(t.id))
          return <TileMesh key={t.id} tile={t} geom={g} showLabel={showLabels} />
        return (
          <group key={t.id} rotation={rot}>
            <TileMesh tile={t} geom={g} showLabel={showLabels} />
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
  const showLabels = usePlanet(s => s.showLabels)
  const finishAnim = usePlanet(s => s._finishAnim)

  return (
    <group>
      {anim ? (
        <AnimSlice
          key={anim.id}
          tiles={tiles}
          geoms={geoms}
          anim={anim}
          onRest={finishAnim}
          showLabels={showLabels}
        />
      ) : drag ? (
        <DragSlice tiles={tiles} geoms={geoms} drag={drag} showLabels={showLabels} />
      ) : (
        <StaticPlanet tiles={tiles} geoms={geoms} showLabels={showLabels} />
      )}
    </group>
  )
}

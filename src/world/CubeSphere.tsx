import { useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useSpring, animated, easings } from '@react-spring/three'
import { Billboard, Text } from '@react-three/drei'
import { useControls } from 'leva'
import { buildAllTileGeometries, type TileMeshDef } from './tileGeometry'
import { usePlanet, type AnimState, type DragState } from './store'
import { tileInSlice, tileCentroid, type Axis } from './rotation'
import type { Tile } from './tile'
import { grassTexture } from '../diorama/buildDiorama'

const _labelWp = new THREE.Vector3()
const _tileDir = new THREE.Vector3()
const _camDir = new THREE.Vector3()

const ROTATE_MS = 380

const AXIS_TUPLE: Record<Axis, [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
}

// @react-spring's `animated.meshStandardMaterial` + R3F's overloaded JSX
// types trip TS2589 (instantiation excessively deep) at the usage site.
// Aliasing through an `any`-typed binding short-circuits the inference chain
// without changing runtime behavior — same element, same props, same
// everything at runtime; TS just stops trying to unify the full prop set.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AnimatedMaterial: any = animated.meshStandardMaterial

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
  grassMap,
}: {
  tile: Tile
  geom: TileMeshDef
  showLabel: boolean
  /** When set, the tile material uses this texture as `map` and the face
   *  colour switches to white so the texture renders untinted. Per-tile
   *  UVs (tileGeometry.ts, UV_REPEAT=2) make the tile face a small grass
   *  patch. Null → classic face-colour look. */
  grassMap: THREE.Texture | null
}) {
  const [hovered, setHovered] = useState(false)
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
  const { emissive } = useSpring({
    emissive: hovered ? 0.18 : 0,
    config: { duration: 120 },
  })
  return (
    <group quaternion={q}>
      <mesh
        geometry={geom.geometry}
        onPointerOver={() => setHovered(true)}
        onPointerOut={() => setHovered(false)}
      >
        {/* Key on grassMap truthiness so the material REMOUNTS when the
            toggle flips. Three defines USE_MAP at shader-compile time; adding
            a `map` to an already-compiled material doesn't recompile unless
            `needsUpdate = true` is set. R3F doesn't auto-flag that for map
            adds/removes, so toggling grass after initial render otherwise
            binds the texture to a USE_MAP-less shader — which silently
            ignores it. Remount is cheap (three.js pooled material creation)
            and sidesteps the needsUpdate dance entirely. */}
        <AnimatedMaterial
          key={grassMap ? 'grass' : 'plain'}
          color={grassMap ? '#ffffff' : geom.color}
          map={grassMap}
          roughness={0.7}
          metalness={0.05}
          emissive="#ffb56b"
          emissiveIntensity={emissive}
        />
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
  grassMap,
}: {
  tiles: readonly Tile[]
  geoms: TileMeshDef[]
  showLabels: boolean
  grassMap: THREE.Texture | null
}) {
  return (
    <>
      {tiles.map(t => (
        <TileMesh key={t.id} tile={t} geom={geoms[t.id]} showLabel={showLabels} grassMap={grassMap} />
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
  grassMap,
}: {
  tiles: readonly Tile[]
  geoms: TileMeshDef[]
  anim: AnimState
  onRest: () => void
  showLabels: boolean
  grassMap: THREE.Texture | null
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
          return <TileMesh key={t.id} tile={t} geom={g} showLabel={showLabels} grassMap={grassMap} />
        return (
          <animated.group
            key={t.id}
            rotation-x={rot.to(r => axisTuple[0] * r)}
            rotation-y={rot.to(r => axisTuple[1] * r)}
            rotation-z={rot.to(r => axisTuple[2] * r)}
          >
            <TileMesh tile={t} geom={g} showLabel={showLabels} grassMap={grassMap} />
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
  grassMap,
}: {
  tiles: readonly Tile[]
  geoms: TileMeshDef[]
  drag: DragState
  showLabels: boolean
  grassMap: THREE.Texture | null
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
          return <TileMesh key={t.id} tile={t} geom={g} showLabel={showLabels} grassMap={grassMap} />
        return (
          <group key={t.id} rotation={rot}>
            <TileMesh tile={t} geom={g} showLabel={showLabels} grassMap={grassMap} />
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

  // Leva toggle for grass map. Live, reactive — the prop flows straight to
  // every TileMesh's meshStandardMaterial `map`, which three.js rebinds on
  // prop change without a full material swap.
  const { grass } = useControls('Rubik (classic)', { grass: false })
  // Reuse the diorama's cached grass texture upload — same GPU slot.
  const grassMap = useMemo(() => grass ? grassTexture() : null, [grass])

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
          grassMap={grassMap}
        />
      ) : drag ? (
        <DragSlice tiles={tiles} geoms={geoms} drag={drag} showLabels={showLabels} grassMap={grassMap} />
      ) : (
        <StaticPlanet tiles={tiles} geoms={geoms} showLabels={showLabels} grassMap={grassMap} />
      )}
    </group>
  )
}

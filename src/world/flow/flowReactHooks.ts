/**
 * R3F integration helper. Mounts a single useFrame that fans
 * `clock.elapsedTime` out to every flow material registered via
 * createFlowMaterial — so callers don't each have to wire their own
 * useFrame, and the time uniform stays consistent across surfaces.
 *
 * Usage in any r3f scene:
 *   <FlowTimeTicker />
 *   <mesh material={createFlowMaterial({ flowSource: 'uniform', uniformFlow: [1, 0] })} ... />
 *
 * For finer per-material control (different speeds, manual pause), don't
 * mount the ticker — drive each material's `uniforms.uTime.value`
 * yourself, or shadow it with a per-mesh useFrame.
 */
import { useFrame } from '@react-three/fiber'
import { tickFlowTime } from './flowMaterial'

export function FlowTimeTicker(): null {
  useFrame(({ clock }) => tickFlowTime(clock.elapsedTime))
  return null
}

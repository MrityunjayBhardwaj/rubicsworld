/**
 * Flow shader — modular CellFluids-style stylized water/fluid that
 * works on any geometry.
 *
 * Quick start:
 *
 *   import { createFlowMaterial, FlowTimeTicker } from '@/world/flow'
 *
 *   const fluidMat  = createFlowMaterial({ flowSource: 'uv2' })            // CF2 mesh
 *   const groundMat = createFlowMaterial({ flowSource: 'uniform',          // plain plane
 *                                          uniformFlow: [0.6, 0],
 *                                          shallowColor: '#7ab752', ... })
 *
 *   <FlowTimeTicker />              // drives all flow materials' uTime
 *   <mesh ... material={fluidMat} />
 *   <mesh ... material={groundMat} />
 *
 * For meshes without uv1/uv2/color (PlaneGeometry, BoxGeometry, etc.),
 * call `attachFlowAttributes(geometry)` once before assigning the
 * material — otherwise the shader's varyings read uninitialised
 * buffers and per-pixel output flickers.
 *
 * For sphere-projected use inside the diorama (planet surface), the
 * material can be combined with `patchMaterialForSphere` from
 * src/diorama/TileGrid; flow's onBeforeCompile-friendly form is
 * planned but not yet wired (see roadmap in flowShader.ts).
 */
export { FLOW_VERT, FLOW_FRAG } from './flowShader'
export {
  createFlowMaterial,
  disposeFlowMaterial,
  attachFlowAttributes,
  tickFlowTime,
  flowMaterialCount,
  type FlowOptions,
  type FlowSource,
} from './flowMaterial'
export { FlowTimeTicker } from './flowReactHooks'

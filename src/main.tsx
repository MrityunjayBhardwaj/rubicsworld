import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { DOFTest } from './DOFtest.tsx'
import { GrassTest } from './GrassTest.tsx'
import { BakeRoute } from './BakeRoute.tsx'
import { FluidTest } from './FluidTest.tsx'

// No router — pathname gate.
//   /DOFtest/   → minimal DoF repro scene
//   /GrassTest/ → minimal cursor-hover grass repro scene
//   /bake       → headless diorama → public/diorama.glb commit page
//   /optimize   → historical A/B alias; behaves identically to / since
//                 the optimized render path was promoted to default
//                 (closes #36; PK8 probe: 3.1× render, 2.6× fps).
//   /fluid      → CellFluids 2 FBX viewer — verify per-vertex flow
//                 channels (UV1/UV2/COLOR_0) before wiring the shader
//   else        → full app
const path = typeof window !== 'undefined' ? window.location.pathname.toLowerCase() : ''
const isDofTest   = path.startsWith('/doftest')
const isGrassTest = path.startsWith('/grasstest')
const isBake      = path.startsWith('/bake')
const isFluid     = path.startsWith('/fluid')

// Module-flag read by TileGrid: enables BatchedMesh build, per-tile
// back-face cull, frustum cull. Always on now — was the /optimize/
// A/B switch (issue #20) before #36 promoted it to default.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __rwOptimize?: boolean }).__rwOptimize = true
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isBake
      ? <BakeRoute />
      : isFluid ? <FluidTest />
      : isDofTest ? <DOFTest /> : isGrassTest ? <GrassTest /> : <App />}
  </StrictMode>,
)

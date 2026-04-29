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
//   /optimize   → full app + sphere-tile back-face & frustum culling
//                 (A/B baseline against / to measure perf wins)
//   /fluid      → CellFluids 2 FBX viewer — verify per-vertex flow
//                 channels (UV1/UV2/COLOR_0) before wiring the shader
//   else        → full app
const path = typeof window !== 'undefined' ? window.location.pathname.toLowerCase() : ''
const isDofTest   = path.startsWith('/doftest')
const isGrassTest = path.startsWith('/grasstest')
const isBake      = path.startsWith('/bake')
const isOptimize  = path.startsWith('/optimize')
const isFluid     = path.startsWith('/fluid')

// Module-flag read by TileGrid + others. /optimize/ enables sphere-tile
// back-face & frustum culling for A/B perf comparison vs default route.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __rwOptimize?: boolean }).__rwOptimize = isOptimize
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isBake
      ? <BakeRoute />
      : isFluid ? <FluidTest />
      : isDofTest ? <DOFTest /> : isGrassTest ? <GrassTest /> : <App />}
  </StrictMode>,
)

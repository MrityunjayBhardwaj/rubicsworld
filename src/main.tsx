import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { DOFTest } from './DOFtest.tsx'
import { GrassTest } from './GrassTest.tsx'
import { BakeRoute } from './BakeRoute.tsx'
import { FluidTest } from './FluidTest.tsx'
import { usePlanet } from './world/store.ts'
import { getPlanet } from './world/planetManifest.ts'

// No router — pathname gate.
//   /DOFtest/                    → minimal DoF repro scene
//   /GrassTest/                  → minimal cursor-hover grass repro scene
//   /bake                        → headless diorama → glb commit page
//   /optimize                    → historical alias; falls through to / (the
//                                  formerly optimize-only render path is now
//                                  the default).
//   /fluid                       → CellFluids 2 FBX viewer — verify per-
//                                  vertex flow channels (UV1/UV2/COLOR_0)
//                                  before wiring the shader
//   /game                        → jam route: title screen + menu, no Leva
//                                  chrome. Same App component, route-gated UI.
//   /edit/levels/lvl_<N>/?glb=1  → dev playground targeting a specific level
//                                  slot. Sets store.currentPlanetSlug from
//                                  the URL so TileGrid + bake commits hit
//                                  that slot, with glb hot-reload watching
//                                  it. Falls back to lvl_1 if slug unknown.
//   else                         → full app (dev playground with all panels)
const path = typeof window !== 'undefined' ? window.location.pathname.toLowerCase() : ''
const isDofTest   = path.startsWith('/doftest')
const isGrassTest = path.startsWith('/grasstest')
const isBake      = path.startsWith('/bake')
const isFluid     = path.startsWith('/fluid')
const isGame      = path.startsWith('/game')

// /edit/levels/lvl_<N>/ — extract level slug from URL and pre-set the store
// before App mounts. This fires before any consumer reads currentPlanetSlug,
// so TileGrid sees the correct active level on its first render and the bake
// commit endpoint targets the right slot. Validates against the manifest;
// invalid slugs log + leave the localStorage default in place.
const editMatch = path.match(/^\/edit\/levels\/(lvl_\d+)\/?/)
if (editMatch) {
  const slug = editMatch[1]
  if (getPlanet(slug)) {
    usePlanet.setState({ currentPlanetSlug: slug })
  } else {
    console.warn(`[main] /edit/levels/ — unknown slug "${slug}", staying on persisted level`)
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isBake
      ? <BakeRoute />
      : isFluid ? <FluidTest />
      : isDofTest ? <DOFTest /> : isGrassTest ? <GrassTest />
      : <App route={isGame ? 'game' : 'dev'} />}
  </StrictMode>,
)

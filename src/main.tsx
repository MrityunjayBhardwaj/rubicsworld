import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { DOFTest } from './DOFtest.tsx'
import { GrassTest } from './GrassTest.tsx'
import { BakeRoute } from './BakeRoute.tsx'

// No router — pathname gate.
//   /DOFtest/   → minimal DoF repro scene
//   /GrassTest/ → minimal cursor-hover grass repro scene
//   /bake       → headless diorama → public/diorama.glb commit page
//   else        → full app
const path = typeof window !== 'undefined' ? window.location.pathname.toLowerCase() : ''
const isDofTest   = path.startsWith('/doftest')
const isGrassTest = path.startsWith('/grasstest')
const isBake      = path.startsWith('/bake')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isBake
      ? <BakeRoute />
      : isDofTest ? <DOFTest /> : isGrassTest ? <GrassTest /> : <App />}
  </StrictMode>,
)

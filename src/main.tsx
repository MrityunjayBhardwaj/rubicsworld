import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { DOFTest } from './DOFtest.tsx'

// No router — pathname gate. /DOFtest/ renders the minimal DoF repro scene;
// anything else boots the full app.
const isDofTest = typeof window !== 'undefined' &&
  window.location.pathname.toLowerCase().startsWith('/doftest')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isDofTest ? <DOFTest /> : <App />}
  </StrictMode>,
)

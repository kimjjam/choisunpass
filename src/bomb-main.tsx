import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import BombPage from './pages/BombPage'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BombPage />
  </StrictMode>,
)

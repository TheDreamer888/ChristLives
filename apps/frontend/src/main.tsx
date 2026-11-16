import { StrictMode, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import Root from './Root.tsx'

createRoot(document.getElementById('root')!).render(
  createElement(StrictMode, null, createElement(Root)),
)

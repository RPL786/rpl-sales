import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import './v2/theme-day.css'
import { installAuthFetch } from './v2/authFetch'
import { bootTheme } from './v2/theme'

installAuthFetch()
bootTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

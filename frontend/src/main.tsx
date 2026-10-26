import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import './v2/theme-day.css'
import './v2/theme-v2.css'
import { installAuthFetch } from './v2/authFetch'
import { bootTheme } from './v2/theme'
import { installTilt } from './v2/motion'
import { setupPwa } from './v2/pwa'
import { installQueueSync } from './v2/offlineQueue'

installAuthFetch()
bootTheme()
installTilt()
setupPwa()
if (localStorage.getItem('auth_token')) installQueueSync()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

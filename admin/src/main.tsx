import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { I18nProvider } from './i18n'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('root element not found')

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
)

import { useState } from 'react'
import { FixturesPage } from './pages/Fixtures'
import { MatchPage } from './pages/Match'
import { TeamsPage } from './pages/Teams'
import { SettingsPage } from './pages/Settings'
import { Reviews } from './pages/Reviews'
import { setLang, useLang, useT } from './i18n'
import type { Fixture } from './api'

type Tab = 'fixtures' | 'match' | 'teams' | 'reviews' | 'settings'

export function App() {
  const [tab, setTab] = useState<Tab>('fixtures')
  const [activeFixture, setActiveFixture] = useState<Fixture | null>(null)
  const t = useT()
  const lang = useLang()

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          ⚽ {t('appTitle')} <span className="owl">· OwlCoda</span>
        </div>
        <nav className="tabs">
          {(
            [
              ['fixtures', t('navFixtures')],
              ['match', t('navMatch')],
              ['teams', t('navTeams')],
              ['reviews', t('navReviews')],
              ['settings', t('navSettings')],
            ] as Array<[Tab, string]>
          ).map(([key, label]) => (
            <button key={key} className={`tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </nav>
        <button className="chip lang-toggle" onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}>
          {lang === 'zh' ? 'EN' : '中文'}
        </button>
        <span className="local-badge">{t('localBadge')}</span>
      </header>

      <main className="main">
        {tab === 'fixtures' && (
          <FixturesPage
            onOpen={(f) => {
              setActiveFixture(f)
              setTab('match')
            }}
          />
        )}
        {tab === 'match' && <MatchPage fixture={activeFixture} />}
        {tab === 'teams' && <TeamsPage />}
        {tab === 'reviews' && <Reviews />}
        {tab === 'settings' && <SettingsPage />}
      </main>

      <footer className="footer">
        Powered by <a href="https://github.com/yeemio/owlcoda" target="_blank" rel="noreferrer">OwlCoda</a> — {t('footer')}
      </footer>
    </div>
  )
}

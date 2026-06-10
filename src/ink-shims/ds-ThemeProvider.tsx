// Minimal ThemeProvider shim for OwlCoda's Ink fork.
// OwlCoda has its own theme system — this just provides the API surface
// that ink.ts expects without pulling in upstream's config/theme deps.

import React, { createContext, useContext, useState } from 'react'

type ThemeName = 'dark' | 'light'
type ThemeSetting = ThemeName | 'auto'

type ThemeContextValue = {
  themeSetting: ThemeSetting
  setThemeSetting: (setting: ThemeSetting) => void
  setPreviewTheme: (setting: ThemeSetting) => void
  savePreview: () => void
  cancelPreview: () => void
  currentTheme: ThemeName
}

const DEFAULT_THEME: ThemeName = 'dark'

const ThemeContext = createContext<ThemeContextValue>({
  themeSetting: DEFAULT_THEME,
  setThemeSetting: () => {},
  setPreviewTheme: () => {},
  savePreview: () => {},
  cancelPreview: () => {},
  currentTheme: DEFAULT_THEME,
})

export function useTheme(): [ThemeName, ThemeContextValue] {
  const ctx = useContext(ThemeContext)
  return [ctx.currentTheme, ctx]
}

export function usePreviewTheme(): (setting: ThemeSetting) => void {
  return useContext(ThemeContext).setPreviewTheme
}

export function ThemeProvider({ children }: { children: React.ReactNode }): React.ReactNode {
  const [theme] = useState<ThemeName>(DEFAULT_THEME)
  const value: ThemeContextValue = {
    themeSetting: theme,
    setThemeSetting: () => {},
    setPreviewTheme: () => {},
    savePreview: () => {},
    cancelPreview: () => {},
    currentTheme: theme,
  }
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useThemeSetting(): [ThemeSetting, (s: ThemeSetting) => void] {
  return ['dark', () => {}]
}

export type { ThemeName, ThemeSetting }

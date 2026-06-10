// Minimal color shim for OwlCoda's Ink fork.
// Provides the color() function that ink.ts exports for themed coloring.

// Minimal color shim. OwlCoda's own theme system handles actual coloring.
export function color(_name: string, _theme?: string): (text: string) => string {
  return (text: string) => text
}

export type ThemeName = 'dark' | 'light'
export type Theme = Record<string, string>

import { getTheme, type OwlTheme } from './tui/colors.js'

export function themeToInkHex(token: keyof OwlTheme): string {
  const theme = getTheme()
  const color = theme[token]
  const rgbMatch = color.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/)
  if (rgbMatch) {
    const toHex = (value: string) => parseInt(value, 10).toString(16).padStart(2, '0')
    return `#${toHex(rgbMatch[1]!)}${toHex(rgbMatch[2]!)}${toHex(rgbMatch[3]!)}`
  }
  if (color.startsWith('#')) return color
  return color
}

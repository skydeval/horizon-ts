/*
 * Colour helpers for the member colour field (Phase 5 design 7.2): hex to
 * HSL and back for the sliders, and a rough colour name so the current
 * colour can be read in words as well as in hex.
 */

/** Hue in degrees (0 to 359), saturation and lightness in percent. */
export type Hsl = {h: number; s: number; l: number}

const HEX = /^#([0-9A-Fa-f]{6})$/

/** `#RRGGBB` as HSL, or null when it is not one. */
export function hexToHsl(hex: string): Hsl | null {
  const match = HEX.exec(hex.trim())
  if (!match) return null
  const n = parseInt(match[1], 16)
  const r = ((n >> 16) & 0xff) / 255
  const g = ((n >> 8) & 0xff) / 255
  const b = (n & 0xff) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  let h = 0
  let s = 0
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1))
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return {
    h: Math.round(h) % 360,
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  }
}

/** HSL as an upper-case `#RRGGBB`. */
export function hslToHex({h, s, l}: Hsl): string {
  const sat = Math.max(0, Math.min(100, s)) / 100
  const light = Math.max(0, Math.min(100, l)) / 100
  const hue = ((h % 360) + 360) % 360
  const c = (1 - Math.abs(2 * light - 1)) * sat
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = light - c / 2
  const [r, g, b] =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : hue < 300
              ? [x, 0, c]
              : [c, 0, x]
  const part = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase()
}

export type ColorHue =
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'teal'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'brown'
  | 'grey'
  | 'white'
  | 'black'

/** A rough name for a colour: a hue word and an optional shade. */
export function colorName(
  hex: string,
): {hue: ColorHue; shade?: 'light' | 'dark'} | null {
  const hsl = hexToHsl(hex)
  if (!hsl) return null
  const {h, s, l} = hsl
  if (l >= 95) return {hue: 'white'}
  if (l <= 8) return {hue: 'black'}
  const shade = l >= 70 ? 'light' : l <= 30 ? 'dark' : undefined
  if (s < 12) return {hue: 'grey', shade}
  let hue: ColorHue
  if (h < 15 || h >= 345) hue = 'red'
  else if (h < 45) hue = l < 45 && s < 80 ? 'brown' : 'orange'
  else if (h < 65) hue = 'yellow'
  else if (h < 160) hue = 'green'
  else if (h < 190) hue = 'teal'
  else if (h < 255) hue = 'blue'
  else if (h < 290) hue = 'purple'
  else hue = 'pink'
  return {hue, shade}
}

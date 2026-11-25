/*
 * Verification badges from prism: the catalogue (`getBadges`), which badges
 * an account holds, and the drawing rule prism's admin preview uses
 * (`docs/internal/notes/verification/badge-shapes.json`), so a badge looks
 * the same in both. Pure: no React, no network.
 */

/** The 24x24 shape paths, exactly as prism draws them. */
export const BADGE_SHAPES = {
  check: 'M9.5 19.2 2.6 12.3l2.6-2.6 4.3 4.3L18.8 4.7l2.6 2.6z',
  seal: 'M12 2.6Q15.16 0.22 16.7 3.86Q20.63 3.37 20.14 7.3Q23.78 8.84 21.4 12Q23.78 15.16 20.14 16.7Q20.63 20.63 16.7 20.14Q15.16 23.78 12 21.4Q8.84 23.78 7.3 20.14Q3.37 20.63 3.86 16.7Q0.22 15.16 2.6 12Q0.22 8.84 3.86 7.3Q3.37 3.37 7.3 3.86Q8.84 0.22 12 2.6z',
  shield: 'M12 1.8 3.5 5v6.2c0 5.3 3.6 10.1 8.5 11 4.9-.9 8.5-5.7 8.5-11V5z',
  star: 'M12 1.5l3.1 6.6 7.2.9-5.3 5 1.4 7.2L12 17.6l-6.4 3.6 1.4-7.2-5.3-5 7.2-.9z',
  circle: 'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20z',
  heart:
    'M12 21.4l-1.5-1.3C5.4 15.4 2 12.3 2 8.5 2 5.4 4.4 3 7.5 3c1.7 0 3.4.8 4.5 2.1C13.1 3.8 14.8 3 16.5 3 19.6 3 22 5.4 22 8.5c0 3.8-3.4 6.9-8.5 11.5z',
  diamond: 'M12 1.5 22.5 12 12 22.5 1.5 12z',
} as const

/** The check drawn as a mark inside a shape. */
export const MARK_CHECK = 'M9.2 16.6 4.6 12l1.8-1.8 2.8 2.8 8.4-8.4 1.8 1.8z'

/** A mark is drawn at this share of the badge, centred. */
export const MARK_SCALE = 0.55

export type BadgeShape = keyof typeof BADGE_SHAPES | 'image'

export type BadgeFill =
  | {kind: 'solid'; color: string}
  | {kind: 'gradient'; from: string; to: string; angle: number}

export type BadgeMark = {
  kind: 'check' | 'glyph' | 'text'
  value?: string
  color: string
}

export type BadgeOutline = {color: string; width: number}

export type BadgeDesign = {
  shape: BadgeShape
  fill: BadgeFill
  mark?: BadgeMark
  outline?: BadgeOutline
  image?: string
}

export type Badge = {
  id: string
  name: string
  description: string
  color: string
  isDefault: boolean
  order: number
  /** Light-theme design. */
  design: BadgeDesign
  /** Dark-theme design: the light one with prism's dark overrides. */
  dark: BadgeDesign
}

/** One badge an account holds, as prism lists it. */
export type HeldBadge = {
  id: string
  issuer: string
  uri: string
  isValid: boolean
  createdAt: string
}

const HEX = /^#[0-9a-f]{6}$/i

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function color(value: unknown): string | undefined {
  const s = str(value)
  return s && HEX.test(s) ? s : undefined
}

function parseFill(value: unknown): BadgeFill | undefined {
  if (!isObject(value)) return undefined
  if (value.kind === 'solid') {
    const c = color(value.color)
    return c ? {kind: 'solid', color: c} : undefined
  }
  if (value.kind === 'gradient') {
    const from = color(value.from)
    const to = color(value.to)
    if (!from || !to) return undefined
    const angle = typeof value.angle === 'number' ? value.angle : 0
    return {kind: 'gradient', from, to, angle}
  }
  return undefined
}

function parseMark(value: unknown): BadgeMark | undefined {
  if (!isObject(value)) return undefined
  const kind = value.kind
  if (kind !== 'check' && kind !== 'glyph' && kind !== 'text') return undefined
  const c = color(value.color)
  if (!c) return undefined
  if (kind === 'check') return {kind, color: c}
  // A glyph or text mark is one or two characters
  const chars = Array.from(str(value.value) ?? '')
  if (chars.length < 1 || chars.length > 2) return undefined
  return {kind, value: chars.join(''), color: c}
}

function parseOutline(value: unknown): BadgeOutline | undefined {
  if (!isObject(value)) return undefined
  const c = color(value.color)
  const width = value.width
  if (!c || typeof width !== 'number') return undefined
  return {color: c, width: Math.min(8, Math.max(1, Math.round(width)))}
}

/** prism serves badge images itself; anything else is not drawn. */
function parseImage(value: unknown, prismUrl: string): string | undefined {
  const s = str(value)
  if (!s) return undefined
  try {
    const url = new URL(s, prismUrl)
    if (url.origin !== new URL(prismUrl).origin) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

function fallbackDesign(c: string): BadgeDesign {
  return {shape: 'check', fill: {kind: 'solid', color: c}}
}

function parseDesign(
  value: unknown,
  c: string,
  prismUrl: string,
): {design: BadgeDesign; dark: BadgeDesign} {
  if (!isObject(value)) {
    const design = fallbackDesign(c)
    return {design, dark: design}
  }
  const shape = value.shape
  const isShape =
    typeof shape === 'string' && (shape === 'image' || shape in BADGE_SHAPES)
  const fill = parseFill(value.fill)
  const image = parseImage(value.image, prismUrl)
  if (!isShape || !fill || (shape === 'image' && !image)) {
    const design = fallbackDesign(c)
    return {design, dark: design}
  }
  const design: BadgeDesign = {
    shape: shape as BadgeShape,
    fill,
    mark: parseMark(value.mark),
    outline: parseOutline(value.outline),
    image,
  }
  const dark: BadgeDesign = {...design}
  if (isObject(value.dark)) {
    const d = value.dark
    const darkFill = parseFill(d.fill)
    if (darkFill) dark.fill = darkFill
    const darkMark = parseMark(d.mark)
    if (darkMark) dark.mark = darkMark
    const darkOutline = parseOutline(d.outline)
    if (darkOutline) dark.outline = darkOutline
    const darkImage = parseImage(d.image, prismUrl)
    if (darkImage) dark.image = darkImage
  }
  return {design, dark}
}

/** The catalogue from a `getBadges` answer, in prism's order. */
export function parseBadgeCatalog(answer: unknown, prismUrl: string): Badge[] {
  if (!isObject(answer) || !Array.isArray(answer.badges)) return []
  const seen = new Set<string>()
  const badges: Badge[] = []
  answer.badges.forEach((entry, index) => {
    if (!isObject(entry)) return
    const id = str(entry.id)
    const name = str(entry.name)
    if (!id || !name || seen.has(id)) return
    seen.add(id)
    const c = color(entry.color) ?? '#1D9BF0'
    badges.push({
      id,
      name,
      description: str(entry.description) ?? '',
      color: c,
      isDefault: entry.default === true,
      order: typeof entry.order === 'number' ? entry.order : index,
      ...parseDesign(entry.design, c, prismUrl),
    })
  })
  return badges.sort((x, y) => x.order - y.order)
}

function parseHeld(value: unknown): HeldBadge | undefined {
  if (!isObject(value)) return undefined
  const id = str(value.id)
  const issuer = str(value.issuer)
  const uri = str(value.uri)
  if (!id || !issuer || !uri) return undefined
  return {
    id,
    issuer,
    uri,
    isValid: value.isValid === true,
    createdAt: str(value.createdAt) ?? '',
  }
}

/** The held badges in a `getSubjectBadges` answer, by DID. */
export function parseSubjectBadges(answer: unknown): Map<string, HeldBadge[]> {
  const out = new Map<string, HeldBadge[]>()
  if (!isObject(answer) || !Array.isArray(answer.subjects)) return out
  for (const subject of answer.subjects) {
    if (!isObject(subject)) continue
    const did = str(subject.did)
    if (!did || !Array.isArray(subject.badges)) continue
    const held = subject.badges
      .map(parseHeld)
      .filter((b): b is HeldBadge => !!b)
    out.set(did, held)
  }
  return out
}

/** A badge an account holds, with every valid record that awards it. */
export type ShownBadge = {badge: Badge; awards: HeldBadge[]}

/**
 * The badges to show for an account: valid awards only, one entry per
 * badge, in the catalogue's order. Ids the catalogue doesn't know are
 * dropped.
 */
export function badgesToShow(
  held: readonly HeldBadge[] | undefined,
  catalog: readonly Badge[] | undefined,
): ShownBadge[] {
  if (!held?.length || !catalog?.length) return []
  const shown: ShownBadge[] = []
  for (const badge of catalog) {
    const awards = held.filter(h => h.id === badge.id && h.isValid)
    if (awards.length) shown.push({badge, awards})
  }
  return shown
}

/** The gradient's end points as fractions of the box (objectBoundingBox). */
export function gradientVector(angle: number): {
  x1: number
  y1: number
  x2: number
  y2: number
} {
  const r = (angle * Math.PI) / 180
  const cos = round(Math.cos(r))
  const sin = round(Math.sin(r))
  return {
    x1: round(0.5 - cos / 2),
    y1: round(0.5 - sin / 2),
    x2: round(0.5 + cos / 2),
    y2: round(0.5 + sin / 2),
  }
}

/**
 * The outline rule: `width` is in half pixels at a 16px badge, so `w =
 * width * 0.75` in the 24-unit box. The shape shrinks by `k` about the
 * centre so the stroke stays inside, and is stroked `w / k` wide in the
 * shrunk space.
 */
export function outlineGeometry(width: number): {
  scale: number
  strokeWidth: number
} {
  const w = width * 0.75
  const k = (24 - w) / 24
  return {scale: round(k), strokeWidth: round(w / k)}
}

/** A glyph or text mark: font size 20 for one character, 15 for two. */
export function markFontSize(value: string): number {
  return Array.from(value).length > 1 ? 15 : 20
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

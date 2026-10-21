/*
 * The Starfield tile (change list 3, item 3): a fixed set of small white
 * stars in a square tile, repeated over the frame from its origin like the
 * grain. The stars come from a fixed seed, so the tile is the same on every
 * load and on every platform. Web draws it as one SVG image, built once per
 * page (`starTileUrl`); native draws the same circles as an SVG pattern
 * (`CompiledSvg.tsx`). Nothing twinkles, nothing is redrawn per frame.
 */

/** The tile's side, in pixels. Large, so the repeat is hard to see. */
export const STAR_TILE = 256

/** How many stars one tile holds. */
export const STAR_COUNT = 44

/** The brightest star's alpha; the glass treats every star as this bright. */
export const STAR_MAX_ALPHA = 0.7

export type Star = {
  /** Centre, in tile pixels. */
  x: number
  y: number
  /** Radius, in pixels. */
  r: number
  /** 0..STAR_MAX_ALPHA. */
  a: number
}

/** A small seeded generator (mulberry32), 0 <= x < 1. */
function seeded(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let x = s
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

function round(value: number, digits: number) {
  const f = 10 ** digits
  return Math.round(value * f) / f
}

/*
 * Mostly faint pinpricks, one in eight a little larger and brighter. Kept a
 * radius away from the tile's edges so no star is cut where tiles meet.
 */
function makeStars(): Star[] {
  const random = seeded(0x57a25)
  const out: Star[] = []
  for (let i = 0; i < STAR_COUNT; i++) {
    const bright = random() < 0.125
    const r = bright ? 1.1 + random() * 0.4 : 0.45 + random() * 0.45
    const a = bright
      ? STAR_MAX_ALPHA - random() * 0.1
      : 0.22 + random() * (STAR_MAX_ALPHA - 0.32)
    const margin = 2
    out.push({
      x: round(margin + random() * (STAR_TILE - 2 * margin), 1),
      y: round(margin + random() * (STAR_TILE - 2 * margin), 1),
      r: round(r, 2),
      a: round(a, 2),
    })
  }
  return out
}

/** The tile's stars. */
export const STARS: readonly Star[] = makeStars()

let url: string | undefined

/**
 * The tile as an SVG data URL, built on first use and kept. Pure string
 * work, so it needs no canvas and is the same in every browser.
 */
export function starTileUrl(): string {
  if (url === undefined) {
    const circles = STARS.map(
      s =>
        `<circle cx="${s.x}" cy="${s.y}" r="${s.r}" fill="#FFFFFF" fill-opacity="${s.a}"/>`,
    ).join('')
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${STAR_TILE}" height="${STAR_TILE}" viewBox="0 0 ${STAR_TILE} ${STAR_TILE}">${circles}</svg>`
    url = `data:image/svg+xml,${encodeURIComponent(svg)}`
  }
  return url
}

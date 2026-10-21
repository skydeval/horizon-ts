/*
 * The film grain tile on web (change list 2, item 6): 128 x 128 pixels of
 * faint black and white specks, drawn once into a canvas the first time a
 * backdrop with grain is painted, kept as a PNG data URL and repeated as a
 * background image. No filter, no `backdrop-filter`, nothing per frame: the
 * browser decodes the tile once and paints it like any other image. The
 * specks come from a fixed seed, so the tile is the same on every load.
 */

/** The tile's side, in pixels. */
export const GRAIN_TILE = 128

/** The strongest speck's alpha, 0-255 (about 0.07). */
const MAX_ALPHA = 18

let url: string | null | undefined

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

function draw(): string | null {
  if (typeof document === 'undefined') return null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = GRAIN_TILE
    canvas.height = GRAIN_TILE
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const image = ctx.createImageData(GRAIN_TILE, GRAIN_TILE)
    const random = seeded(0x5eed)
    for (let i = 0; i < image.data.length; i += 4) {
      const v = random() < 0.5 ? 0 : 255
      image.data[i] = v
      image.data[i + 1] = v
      image.data[i + 2] = v
      image.data[i + 3] = Math.round(random() * MAX_ALPHA)
    }
    ctx.putImageData(image, 0, 0)
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

/** The tile as a data URL, drawn on first use; null without a canvas. */
export function grainTileUrl(): string | null {
  if (url === undefined) url = draw()
  return url
}

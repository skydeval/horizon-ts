/*
 * A link card's image goes through Bluesky's card service (cardyb), which
 * some sites turn away (GitHub limits it), so the card loses its picture.
 * When that fails, the composer fetches the site's own image directly.
 */

const CARDYB_IMAGE = /^https:\/\/cardyb(\.staging)?\.bsky\.(app|dev)\/v1\/image$/

/**
 * The site's own image behind a card service image link, or `undefined` for
 * any other link.
 */
export function directImageUrl(image: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(image)
  } catch {
    return undefined
  }
  if (!CARDYB_IMAGE.test(`${parsed.origin}${parsed.pathname}`)) return undefined
  const inner = parsed.searchParams.get('url')
  if (!inner) return undefined
  try {
    return new URL(inner).protocol === 'https:' ? inner : undefined
  } catch {
    return undefined
  }
}

/**
 * Make a thumbnail from `image`, and if that fails, from the site's own
 * image behind it.
 */
export async function thumbWithDirectFallback<T>(
  image: string,
  toThumb: (uri: string) => Promise<T | undefined>,
): Promise<T | undefined> {
  const thumb = await toThumb(image)
  if (thumb) return thumb
  const direct = directImageUrl(image)
  return direct ? await toThumb(direct) : undefined
}

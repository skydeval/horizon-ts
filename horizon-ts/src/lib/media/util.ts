export function extractDataUriMime(uri: string): string {
  return uri.substring(uri.indexOf(':') + 1, uri.indexOf(';'))
}

export function getResizedDimensions(
  originalDims: {
    width: number
    height: number
  },
  maxDimension: number,
) {
  if (
    originalDims.width <= maxDimension &&
    originalDims.height <= maxDimension
  ) {
    return originalDims
  }

  const ratio = Math.min(
    maxDimension / originalDims.width,
    maxDimension / originalDims.height,
  )

  return {
    width: Math.round(originalDims.width * ratio),
    height: Math.round(originalDims.height * ratio),
  }
}

// Fairly accurate estimate that is more performant
// than decoding and checking length of URI
export function getDataUriSize(uri: string): number {
  return Math.round((uri.length * 3) / 4)
}

export function isUriImage(uri: string): boolean {
  return /\.(jpg|jpeg|png|webp).*$/.test(uri)
}

export function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new Error('Failed to read blob'))
      }
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

export type ImgproxyPreset =
  | 'default'
  | 'avatar_thumbnail'
  | 'avatar'
  | 'banner'
  | 'feed_fullsize'
  | 'feed_thumbnail'
  | 'download'

// Using capturing groups here instead of lookbehinds in order to support older versions of Safari.
// https://bugs.webkit.org/show_bug.cgi?id=174931
const IMGPROXY_PRESET_RE =
  /(\/img\/)(default|avatar_thumbnail|avatar|banner|feed_fullsize|feed_thumbnail|download)(\/)/

/**
 * Replaces any imgproxy preset in a CDN URI with the given preset.
 */
export function convertCdnPreset(uri: string, preset: ImgproxyPreset): string {
  return uri.replace(IMGPROXY_PRESET_RE, `$1${preset}$3`)
}

/**
 * HORIZON: the file name for a saved image, `<cid>.jpg`, the same name the
 * CDN's download preset gives. The CID is the `cid` query parameter of a
 * `getBlob` URI, or else the last path segment of a CDN URI without its
 * `@jpeg` format suffix. Saving the same image always gives the same name.
 */
export function savedImageFilename(uri: string): string {
  let id = ''
  try {
    id = new URL(uri).searchParams.get('cid') ?? ''
  } catch {}
  if (!id) {
    const last = uri.split(/[?#]/)[0].split('/').at(-1) ?? ''
    id = last.split('@')[0]
  }
  id = id.replace(/[^A-Za-z0-9_-]/g, '')
  return `${id || 'image'}.jpg`
}

/** HORIZON: whether `uri` is on Bluesky's image CDN. */
export function isCdnImage(uri: string): boolean {
  return uri.startsWith('https://cdn.bsky.app/img/')
}

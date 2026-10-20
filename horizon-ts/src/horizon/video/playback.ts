/*
 * Web playback of a video view whose `playlist` is not HLS. A private post's
 * video plays from the MP4 blob on its author's PDS
 * (`com.atproto.sync.getBlob`), never from the video service's CDN (handoff
 * `prism-private-video-pds.md`). hls.js plays only HLS, so such a URL is set
 * as the `<video>` element's own source. Native players take either already.
 *
 * Such a view has no `thumbnail`, so the element shows the video's first
 * frame as its poster: it preloads metadata, and the source carries a
 * `#t=0.1` media fragment, which Safari needs to paint a frame before play
 * (Chrome and Firefox paint the first frame with metadata alone). The
 * fragment is never sent to the server, and 0.1 s lies in the first bytes,
 * so a PDS that ignores `Range` (Locus today: 200 with the whole file, no
 * `Accept-Ranges`) still serves it. The browser reads that one response in
 * its own media pipeline and suspends it once it has what `metadata` needs
 * (how far it reads first is the browser's choice; an MP4 whose `moov` box
 * is at the end is read through). Nothing is held in the app's memory.
 */

import {PRIVATE_READING} from '#/horizon/switches'

/**
 * Whether `playlist` names an HLS playlist: its URL path ends in `.m3u8`.
 * A URL that does not parse counts as HLS, so the stock path handles it.
 */
export function isHlsPlaylist(playlist: string): boolean {
  try {
    return new URL(playlist).pathname.toLowerCase().endsWith('.m3u8')
  } catch {
    return true
  }
}

/**
 * Whether the web player sets `playlist` as the element's direct source
 * instead of handing it to hls.js. Always `false` with `PRIVATE_READING` off.
 */
export function playsAsDirectSource(playlist: string): boolean {
  return PRIVATE_READING && !isHlsPlaylist(playlist)
}

/**
 * The media fragment a direct source carries, so the element paints a frame
 * before play.
 */
export const POSTER_FRAME_FRAGMENT = '#t=0.1'

/**
 * `MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED`: what a browser reports for a
 * source that answers 404, as well as one it cannot decode.
 */
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4

/**
 * The URL a direct source is set as: `playlist` with
 * {@link POSTER_FRAME_FRAGMENT}, unless it has a fragment already.
 */
export function directSourceUrl(playlist: string): string {
  return playlist.includes('#') ? playlist : playlist + POSTER_FRAME_FRAGMENT
}

/**
 * The `preload` of the web player's element: `metadata` for a direct source
 * without a thumbnail, so its first frame is the poster; else the stock
 * `none`.
 */
export function videoPreload(embed: {
  playlist: string
  thumbnail?: string
}): 'metadata' | 'none' {
  return playsAsDirectSource(embed.playlist) && !embed.thumbnail
    ? 'metadata'
    : 'none'
}

/**
 * The part of a media element the direct source needs.
 */
type MediaElement = {
  src: string
  error?: {code: number} | null
  removeAttribute(name: string): void
  load(): void
  addEventListener?(type: 'error', listener: () => void): void
  removeEventListener?(type: 'error', listener: () => void): void
}

/**
 * Set `url` as the element's source. `onError` is told when the element
 * fails to load it, with whether the source is not found (or not playable),
 * so the stock error fallback shows instead of a dead player. Returns the
 * cleanup, which removes the source again, as the stock effect detaches
 * hls.js.
 */
export function attachDirectSource(
  video: MediaElement,
  url: string,
  onError?: (notFound: boolean) => void,
): () => void {
  const listener = () => {
    onError?.(video.error?.code === MEDIA_ERR_SRC_NOT_SUPPORTED)
  }
  if (onError) video.addEventListener?.('error', listener)
  video.src = url
  return () => {
    if (onError) video.removeEventListener?.('error', listener)
    video.removeAttribute('src')
    video.load()
  }
}

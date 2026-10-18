/*
 * Web playback of a video view whose `playlist` is not HLS. prism may serve a
 * private video's `playlist` as the MP4 blob on the author's PDS
 * (`com.atproto.sync.getBlob`) when the video service's CDN does not serve
 * it (handoff `prism-private-video.md`). hls.js plays only HLS, so such a
 * URL is set as the `<video>` element's own source. Native players take
 * either already.
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
 * The part of a media element the direct source needs.
 */
type MediaElement = {
  src: string
  removeAttribute(name: string): void
  load(): void
}

/**
 * Set `url` as the element's source. Returns the cleanup, which removes the
 * source again, as the stock effect detaches hls.js.
 */
export function attachDirectSource(
  video: MediaElement,
  url: string,
): () => void {
  video.src = url
  return () => {
    video.removeAttribute('src')
    video.load()
  }
}

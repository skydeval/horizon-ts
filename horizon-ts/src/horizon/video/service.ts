/*
 * The video service Horizon uploads to and plays from: today Bluesky's. Kept
 * in one place so it can later be switched to an independent service, or
 * given a fallback, without touching the stock upload and playback code,
 * which read it through `#/lib/constants`.
 */

/**
 * The video service's DID (the audience of its service-auth token) and its
 * URL (uploads, job status and the playback CDN).
 */
export const HORIZON_VIDEO_SERVICE = {
  did: 'did:web:video.bsky.app',
  url: 'https://video.bsky.app',
} as const

/**
 * The HLS playlist the video service serves for a video blob, as Bluesky's
 * AppView builds it: `<service>/watch/<url-encoded did>/<cid>/playlist.m3u8`.
 * Never for a private post's video, which plays from its author's PDS
 * (handoff `prism-private-video-pds.md`).
 */
export function videoPlaylistUrl(did: string, cid: string): string {
  return `${HORIZON_VIDEO_SERVICE.url}/watch/${encodeURIComponent(did)}/${cid}/playlist.m3u8`
}

/**
 * The thumbnail the video service serves beside the playlist. Never for a
 * private post's video.
 */
export function videoThumbnailUrl(did: string, cid: string): string {
  return `${HORIZON_VIDEO_SERVICE.url}/watch/${encodeURIComponent(did)}/${cid}/thumbnail.jpg`
}

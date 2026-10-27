/*
 * A preview build: the production web build served from its own https origin
 * (a public preview, not the release at nearhorizon.app). The build sets
 * `EXPO_PUBLIC_OAUTH_CLIENT=preview` and `EXPO_PUBLIC_PREVIEW_ORIGIN`; see
 * `docs/internal/notes/preview-deploy.md` in the outer repo.
 */

/**
 * The preview origin a build was made for, or `undefined` when it is not a
 * preview build. The origin must be https with nothing after the host (no
 * path, query, fragment or trailing slash); anything else is not a preview
 * origin, and `scripts/horizon-preview-pages.js` refuses it at build time.
 */
export function readPreviewOrigin(
  requestedMode: string | undefined,
  rawOrigin: string | undefined,
): string | undefined {
  if (requestedMode !== 'preview' || !rawOrigin) return undefined
  let url: URL
  try {
    url = new URL(rawOrigin)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || url.origin !== rawOrigin) return undefined
  return rawOrigin
}

/**
 * This build's preview origin, or `undefined` in every other build. Expo
 * inlines `EXPO_PUBLIC_*` variables only where they are read literally, so
 * both are read here.
 */
export const PREVIEW_ORIGIN: string | undefined = readPreviewOrigin(
  process.env.EXPO_PUBLIC_OAUTH_CLIENT,
  process.env.EXPO_PUBLIC_PREVIEW_ORIGIN,
)

/**
 * The host Horizon's share links point at: nearhorizon.app, or a preview
 * build's own origin, so a link copied from the preview opens the preview.
 */
export const SHARE_ORIGIN = PREVIEW_ORIGIN ?? 'https://nearhorizon.app'

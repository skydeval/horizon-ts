/*
 * Horizon: package a preview web build for Cloudflare Pages.
 *
 * Run after `pnpm build-web` made with EXPO_PUBLIC_OAUTH_CLIENT=preview and
 * EXPO_PUBLIC_PREVIEW_ORIGIN=<origin>, with the same two variables set:
 *
 *   EXPO_PUBLIC_OAUTH_CLIENT=preview \
 *   EXPO_PUBLIC_PREVIEW_ORIGIN=https://preview.example \
 *   node scripts/horizon-preview-pages.js [dist-dir]
 *
 * It turns dist/ into a ready-to-upload Pages directory:
 * - dist/oauth-client-metadata.json becomes the preview's own client document
 *   (the production document moved to the preview origin), and the hosted
 *   development document is removed;
 * - _redirects (single-page fallback) and _headers are written;
 * - source maps are removed (the main one is over Pages' 25 MiB file limit,
 *   and a public preview need not publish them);
 * - it fails if the bundle was not built for this origin, or if a file is
 *   over Pages' limits.
 *
 * The pure functions are exported for the unit test in
 * src/horizon/session/__tests__/preview-pages-test.ts, which keeps the
 * document equal to createPreviewClientMetadata in
 * src/horizon/session/oauth-metadata.ts.
 */

/** Pages refuses a file over 25 MiB. */
const MAX_FILE_BYTES = 25 * 1024 * 1024
/** Pages allows 20,000 files per deployment on the free plan. */
const MAX_FILES = 20000

/**
 * The preview origin, checked: https, nothing after the host (no path,
 * query, fragment or trailing slash), lower case. Throws otherwise.
 *
 * @param {string | undefined} raw
 * @returns {string}
 */
function checkPreviewOrigin(raw) {
  if (!raw) {
    throw new Error('EXPO_PUBLIC_PREVIEW_ORIGIN is not set')
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`not a URL: ${raw}`)
  }
  if (url.protocol !== 'https:') {
    throw new Error(`the preview origin must be https: ${raw}`)
  }
  if (url.origin !== raw) {
    throw new Error(
      `the preview origin must be a bare origin such as ${url.origin} ` +
        `(no path, trailing slash, query or upper case): ${raw}`,
    )
  }
  return raw
}

/**
 * The preview's client document: the production document with its client
 * ID, client URI and redirect URI moved to `origin` (same paths), and
 * " (preview)" after the client name. Everything else, scope included, is
 * the production document's.
 *
 * @template {{client_id: string, client_name: string, client_uri: string, redirect_uris: string[]}} T
 * @param {T} production
 * @param {string} origin
 * @returns {T}
 */
function previewClientMetadata(production, origin) {
  const move = (/** @type {string} */ value) => {
    const url = new URL(value)
    return `${origin}${url.pathname === '/' ? '' : url.pathname}${url.search}`
  }
  return {
    ...production,
    client_id: move(production.client_id),
    client_name: `${production.client_name} (preview)`,
    client_uri: move(production.client_uri),
    redirect_uris: production.redirect_uris.map(move),
  }
}

/**
 * Cloudflare Pages' `_redirects`: every path that is not a file is the app.
 * A file that exists (the client document, the bundle) is expected to be
 * served as itself ahead of this rule; the deploy how-to checks it.
 */
const PAGES_REDIRECTS = '/* /index.html 200\n'

/**
 * Cloudflare Pages' `_headers`.
 * - Every path: no sniffing, no framing (the sign-in form should not be
 *   framed by another site), a referrer policy that sends no paths to other
 *   sites, no indexing of a preview, and `Cache-Control: no-store`. The
 *   last is for the app's document: `/`, `/index.html` and every deep path
 *   (the single-page fallback answers those with `index.html`, and a rule
 *   matches the requested path). A `no-store` document is kept out of the
 *   back/forward cache, where a frozen Horizon page can hold the OAuth
 *   library's session lock and hang every other page's sign-in.
 * - Each more specific block below starts with `! Cache-Control`, which
 *   detaches the `no-store` before its own value is set (Pages joins a
 *   header set by two matching rules with a comma otherwise). `/assets/*`
 *   only detaches it, keeping Pages' default caching for those files.
 * - The client document: readable from any origin and revalidated on every
 *   fetch, so a changed document is seen at once.
 * - Metro's content-hashed bundle: cached for good.
 * - The private post encoder's `.wasm` (a content-hashed Metro asset): served
 *   as `application/wasm`, so the browser compiles it while it streams, and
 *   cached for good. Whether Pages already sends that type, and whether this
 *   line replaces its own or adds a second, is checked live (2K design L-2);
 *   if it duplicates, keep only the cache line.
 */
const PAGES_HEADERS = `/*
  X-Content-Type-Options: nosniff
  Content-Security-Policy: frame-ancestors 'self'
  Referrer-Policy: strict-origin-when-cross-origin
  X-Robots-Tag: noindex
  Cache-Control: no-store

/oauth-client-metadata.json
  Access-Control-Allow-Origin: *
  ! Cache-Control
  Cache-Control: no-cache

/_expo/static/*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable

/assets/*
  ! Cache-Control

/assets/vendor/kryphocron-web/*
  Content-Type: application/wasm
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
`

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listFiles(dir) {
  const fs = require('node:fs')
  const path = require('node:path')
  const out = []
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full))
    else out.push(full)
  }
  return out
}

function main() {
  const fs = require('node:fs')
  const path = require('node:path')

  const projectRoot = path.join(__dirname, '..')
  const distDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(projectRoot, 'dist')
  if (process.env.EXPO_PUBLIC_OAUTH_CLIENT !== 'preview') {
    throw new Error(
      'EXPO_PUBLIC_OAUTH_CLIENT must be preview, as it was for the build',
    )
  }
  const origin = checkPreviewOrigin(process.env.EXPO_PUBLIC_PREVIEW_ORIGIN)

  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    throw new Error(
      `${distDir}/index.html is missing; run pnpm build-web first`,
    )
  }

  // The bundle must have been built for this origin (Expo inlines it).
  const jsDir = path.join(distDir, '_expo', 'static', 'js')
  const builtForOrigin = listFiles(jsDir).some(
    file =>
      file.endsWith('.js') && fs.readFileSync(file, 'utf8').includes(origin),
  )
  if (!builtForOrigin) {
    throw new Error(
      `the bundle in ${jsDir} does not contain ${origin}; rebuild with ` +
        `EXPO_PUBLIC_OAUTH_CLIENT=preview EXPO_PUBLIC_PREVIEW_ORIGIN=${origin}`,
    )
  }

  const production = JSON.parse(
    fs.readFileSync(
      path.join(projectRoot, 'public', 'oauth-client-metadata.json'),
      'utf8',
    ),
  )
  const document = previewClientMetadata(production, origin)
  fs.writeFileSync(
    path.join(distDir, 'oauth-client-metadata.json'),
    `${JSON.stringify(document, null, 2)}\n`,
  )
  console.log(`Wrote oauth-client-metadata.json for ${document.client_id}`)
  fs.rmSync(path.join(distDir, 'oauth-client-metadata-dev.json'), {force: true})

  fs.writeFileSync(path.join(distDir, '_redirects'), PAGES_REDIRECTS)
  fs.writeFileSync(path.join(distDir, '_headers'), PAGES_HEADERS)
  console.log('Wrote _redirects and _headers')

  let removedMaps = 0
  for (const file of listFiles(distDir)) {
    if (file.endsWith('.map')) {
      fs.rmSync(file)
      removedMaps++
    }
  }
  console.log(`Removed ${removedMaps} source maps`)

  const files = listFiles(distDir)
  const tooBig = files.filter(file => fs.statSync(file).size > MAX_FILE_BYTES)
  if (tooBig.length > 0) {
    throw new Error(`over Pages' 25 MiB file limit: ${tooBig.join(', ')}`)
  }
  if (files.length > MAX_FILES) {
    throw new Error(`${files.length} files, over Pages' limit of ${MAX_FILES}`)
  }
  console.log(`${distDir} is ready: ${files.length} files`)
}

module.exports = {
  checkPreviewOrigin,
  previewClientMetadata,
  PAGES_REDIRECTS,
  PAGES_HEADERS,
}

if (require.main === module) {
  try {
    main()
  } catch (e) {
    console.error(`horizon-preview-pages: ${e.message}`)
    process.exit(1)
  }
}

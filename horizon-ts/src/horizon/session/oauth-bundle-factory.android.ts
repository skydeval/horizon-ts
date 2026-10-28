/*
 * Android builds OAuth bundles exactly as the web does; the transport and
 * client underneath are the Android ones. The launch wait's Web Lock check
 * answers `unavailable` here (`oauth-lock.ts`), which falls back to the first
 * read, as it should in a single-process app.
 */

export * from './oauth-bundle-factory.web'

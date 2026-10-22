/*
 * The client encoder (2K design PA-31): `index.web.ts` loads it,
 * `index.native.ts` reports it unavailable. Metro and jest always pick one
 * of those; this file only serves a resolver that knows no platform, and
 * answers as native does.
 */

export * from './index.native'

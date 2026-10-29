/*
 * The client encoder on web (2K design PA-31, PA-32): kryphocron's
 * encode-only WebAssembly build, vendored in `vendor/kryphocron-web/`. This
 * and `index.android.ts` are the only modules that import it.
 *
 * The glue is a lazy chunk, loaded on the first `loadEncoder()`; the `.wasm`
 * is a Metro asset whose content-hashed URL comes from the `require` below.
 * The glue's own default path (`new URL(..., import.meta.url)`) points next
 * to the entry chunk under Metro, where no `.wasm` is, so `init` is always
 * given the asset URL.
 */

import {logger} from '#/logger'
import {encodeWith, type PreparePrivatePost} from './encode'
import {
  encodeFailureClassOf,
  type Encoder,
  PrivateEncodeFailedError,
} from './types'

export * from './types'

/*
 * Metro's asset transformer exports the hashed URL as a string on web. A
 * `require` in a `.ts` file is not module-resolved, so TypeScript never reads
 * the vendored `kryphocron_web_bg.wasm.d.ts` (the raw exports) for it; the
 * value is checked before use.
 */
const wasmUrl: unknown = require('../../../../vendor/kryphocron-web/kryphocron_web_bg.wasm')

/**
 * Whether this browser can run the encoder: WebAssembly, and a CSRNG for the
 * slug (the glue has no other source, D-0.8). Also Web Locks: the outbox
 * that posts on this route runs each compose under its run lock, so a
 * browser without them (an old one, an insecure origin) gets posting route
 * `none` with reason `no-encoder` (2K design PA-28, K9-N5).
 */
export function encoderAvailable(): boolean {
  return (
    typeof WebAssembly === 'object' &&
    typeof globalThis.crypto?.getRandomValues === 'function' &&
    typeof (globalThis as {navigator?: {locks?: unknown}}).navigator?.locks ===
      'object'
  )
}

let loading: Promise<Encoder> | undefined

/**
 * The encoder, loaded once per run. A failure (class `load`) clears the memo,
 * so the next call loads again.
 */
export function loadEncoder(): Promise<Encoder> {
  if (!loading) {
    const attempt = load()
    loading = attempt
    attempt.catch(() => {
      if (loading === attempt) loading = undefined
    })
  }
  return loading
}

/**
 * Start loading the encoder ahead of a private compose (PA-30). Idempotent;
 * a failure is logged by class and forgotten, and the next `loadEncoder()`
 * tries again.
 */
export function prewarmEncoder(): void {
  loadEncoder().catch((error: unknown) => {
    logger.warn('encoder: prewarm failed', {
      failureClass: encodeFailureClassOf(error),
    })
  })
}

async function load(): Promise<Encoder> {
  if (typeof wasmUrl !== 'string') throw new PrivateEncodeFailedError('load')
  let prepare: PreparePrivatePost
  try {
    const glue =
      await import('../../../../vendor/kryphocron-web/kryphocron_web.js')
    await glue.default({module_or_path: wasmUrl})
    prepare = glue.preparePrivatePost
  } catch {
    throw new PrivateEncodeFailedError('load')
  }
  return {encode: input => encodeWith(prepare, input)}
}

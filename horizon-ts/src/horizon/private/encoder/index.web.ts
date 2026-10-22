/*
 * The client encoder on web (2K design PA-31, PA-32): kryphocron's
 * encode-only WebAssembly build, vendored in `vendor/kryphocron-web/`. This
 * is the only module that imports it.
 *
 * The glue is a lazy chunk, loaded on the first `loadEncoder()`; the `.wasm`
 * is a Metro asset whose content-hashed URL comes from the `require` below.
 * The glue's own default path (`new URL(..., import.meta.url)`) points next
 * to the entry chunk under Metro, where no `.wasm` is, so `init` is always
 * given the asset URL.
 */

import {jsonToLex, lexToJson, type LexValue} from '@atproto/lex'

import {logger} from '#/logger'
import {
  PRIVATE_ENCODED_FIELD_KEYS,
  privateEncodedFields,
} from '#/horizon/lexicons/kryphocron'
import {PP_COLLECTION} from '#/horizon/private/uri'
import {
  type EncodedFields,
  encodeFailureClassOf,
  type EncodeInput,
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

type PreparePrivatePost = (
  did: string,
  nsid: string,
  rkey: string,
  contentJson: string,
  nowSecs: number,
) => string

const ENCODED_KEYS: readonly string[] = PRIVATE_ENCODED_FIELD_KEYS

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

/**
 * Throws on any number that is not a safe integer, at any depth of a JSON
 * value. atproto's data model has no floats, and `lexToJson` passes one
 * through, so a float would otherwise reach the encoder.
 */
function assertIntegersOnly(value: unknown): void {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('not an integer')
    return
  }
  if (Array.isArray(value)) {
    value.forEach(assertIntegersOnly)
    return
  }
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(assertIntegersOnly)
  }
}

function encodeWith(
  prepare: PreparePrivatePost,
  {did, rkey, content, nowSecs}: EncodeInput,
): EncodedFields {
  let contentJson: string
  try {
    // Keys absent from the record stay absent; BlobRefs become blob JSON.
    const value: {[key: string]: LexValue} = {text: content.text}
    if (content.facets !== undefined) value.facets = content.facets
    if (content.embed !== undefined) value.embed = content.embed
    const json = lexToJson(value)
    assertIntegersOnly(json)
    contentJson = JSON.stringify(json)
  } catch {
    throw new PrivateEncodeFailedError('input')
  }

  let result: unknown
  try {
    result = prepare(did, PP_COLLECTION, rkey, contentJson, nowSecs)
  } catch {
    throw new PrivateEncodeFailedError('encode')
  }

  return parseOutput(result)
}

function parseOutput(result: unknown): EncodedFields {
  if (typeof result !== 'string') throw new PrivateEncodeFailedError('output')
  let parsed: unknown
  try {
    parsed = jsonToLex(JSON.parse(result))
  } catch {
    throw new PrivateEncodeFailedError('output')
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).some(key => !ENCODED_KEYS.includes(key))
  ) {
    throw new PrivateEncodeFailedError('output')
  }
  const checked = privateEncodedFields.safeValidate(parsed)
  if (!checked.success) throw new PrivateEncodeFailedError('output')
  return checked.value
}

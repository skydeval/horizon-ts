/*
 * The client encoder's surface, shared by the platform files (2K design
 * PA-31). The platform files cannot import `./index` (on web it resolves to
 * `index.web.ts` itself), so the shared types and errors live here.
 */

import {type LexValue} from '@atproto/lex'

import {type PrivateEncodedFields} from '#/horizon/lexicons/kryphocron'

/**
 * The content that is encoded: the composed record's `text`, `facets` and
 * `embed`, as lex values (`BlobRef`s in the embed). `facets` and `embed` only
 * when the post has them.
 */
export type EncoderContent = {
  text: string
  facets?: LexValue[]
  embed?: LexValue
}

export type EncodeInput = {
  /** Always `pdsClient.assertDid` of the write, never a value from a record. */
  did: string
  /** The TID the record is written at. */
  rkey: string
  content: EncoderContent
  /** `Math.floor(Date.now() / 1000)` from the device clock (D-0.12). */
  nowSecs: number
}

/**
 * The fields to add to the record, checked against `privateEncodedFields`.
 */
export type EncodedFields = PrivateEncodedFields

/**
 * The loaded encoder. Stateless: one instance serves every call, and nothing
 * about a call is kept.
 */
export type Encoder = {
  encode(input: EncodeInput): EncodedFields
}

/**
 * Where an encode failed:
 * - `load`: the glue or the `.wasm` could not be fetched or instantiated, or
 *   the asset URL is not a string;
 * - `input`: building the content JSON threw before the encoder ran, or the
 *   content holds a number that is not an integer (atproto has no floats);
 * - `encode`: `preparePrivatePost` threw;
 * - `output`: the result did not parse or did not fit
 *   `privateEncodedFields`.
 */
export type EncodeFailureClass = 'load' | 'input' | 'encode' | 'output'

/**
 * Every failure of `loadEncoder` and `Encoder.encode`. The original error is
 * dropped, never kept as `cause`: the encoder builds its message from inputs
 * Horizon does not see, and `lexToJson`'s messages quote the offending value
 * (PA-18). Only `failureClass` may be logged.
 */
export class PrivateEncodeFailedError extends Error {
  readonly failureClass: EncodeFailureClass

  constructor(failureClass: EncodeFailureClass) {
    super(`The private post could not be prepared (${failureClass})`)
    this.name = 'PrivateEncodeFailedError'
    this.failureClass = failureClass
  }
}

/**
 * This platform has no encoder (native: Hermes has no WebAssembly, D-0.13).
 */
export class PrivateEncoderUnavailableError extends Error {
  constructor() {
    super('The private post encoder is not available on this platform')
    this.name = 'PrivateEncoderUnavailableError'
  }
}

/**
 * The class of a failure from `loadEncoder`, for a log line.
 */
export function encodeFailureClassOf(error: unknown): string {
  if (error instanceof PrivateEncodeFailedError) return error.failureClass
  if (error instanceof PrivateEncoderUnavailableError) return 'unavailable'
  return 'unknown'
}

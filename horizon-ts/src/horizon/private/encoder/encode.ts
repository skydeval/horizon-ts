/*
 * One encode over kryphocron-web's `preparePrivatePost`, the same on every
 * platform: the content in, checked as atproto JSON, and the encoded fields
 * out, checked against the lexicon. Web runs the export from the .wasm,
 * Android from its JavaScript build.
 */

import {jsonToLex, lexToJson, type LexValue} from '@atproto/lex'

import {
  PRIVATE_ENCODED_FIELD_KEYS,
  privateEncodedFields,
} from '#/horizon/lexicons/kryphocron'
import {PP_COLLECTION} from '#/horizon/private/uri'
import {
  type EncodedFields,
  type EncodeInput,
  PrivateEncodeFailedError,
} from './types'

/** The encoder's one export. */
export type PreparePrivatePost = (
  did: string,
  nsid: string,
  rkey: string,
  contentJson: string,
  nowSecs: number,
) => string

const ENCODED_KEYS: readonly string[] = PRIVATE_ENCODED_FIELD_KEYS

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

/**
 * Encode one post's content with `prepare`.
 */
export function encodeWith(
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

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; real encoding needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

import {lexToJson} from '@atproto/lex'

import {privateEncodedFields} from '#/horizon/lexicons/kryphocron'
import type * as AndroidEncoder from '../index.android'

/*
 * The Android encoder (index.android.ts) over the real vendored JavaScript
 * build. Its output equals the .wasm's byte for byte
 * (scripts/kryphocron-native-check.mjs); this checks the loader's wiring.
 */

jest.mock('#/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}))

type EncoderModule = typeof AndroidEncoder

const DID = 'did:plc:abcdefghijklmnopqrstuvwx'
const INPUT = {
  did: DID,
  rkey: '3mabcdefghijk',
  nowSecs: 1793000000,
  content: {text: 'hello ✨ 🌸 é 日本'},
}

describe('the Android encoder', () => {
  const realCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  const realTextDecoder = globalThis.TextDecoder
  let mod: EncoderModule

  beforeEach(() => {
    // A fresh copy (its memo empty), as the web encoder test loads its own
    jest.isolateModules(() => {
      mod = require('../index.android') as EncoderModule
    })
  })

  afterEach(() => {
    if (realCrypto) Object.defineProperty(globalThis, 'crypto', realCrypto)
    globalThis.TextDecoder = realTextDecoder
  })

  it('is available', () => {
    expect(mod.encoderAvailable()).toBe(true)
  })

  it('encodes a post into fields the lexicon accepts, and restores WebAssembly', async () => {
    const realWasm = globalThis.WebAssembly
    const encoder = await mod.loadEncoder()
    expect(globalThis.WebAssembly).toBe(realWasm)
    const fields = encoder.encode(INPUT)
    expect(privateEncodedFields.safeValidate(fields).success).toBe(true)
    // The text is encoded, not carried: nothing of it is left in the fields
    expect(JSON.stringify(lexToJson(fields))).not.toContain('hello')
    expect(Object.keys(fields)).toEqual(
      expect.arrayContaining([
        'encodedContent',
        'encodedContentCodec',
        'encodedContentGeneration',
      ]),
    )
  })

  it('gives the encoder a CSRNG where there is none', async () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
      writable: true,
    })
    const encoder = await mod.loadEncoder()
    expect(typeof globalThis.crypto?.getRandomValues).toBe('function')
    expect(() => encoder.encode(INPUT)).not.toThrow()
  })

  it('loads under a TextDecoder that refuses fatal, then puts it back', async () => {
    class RefusesFatal {
      #inner = new realTextDecoder('utf-8')
      constructor(_label?: string, options?: {fatal?: boolean}) {
        if (options?.fatal) throw new Error("the 'fatal' option is unsupported")
      }
      decode(input?: BufferSource) {
        if (input === undefined) throw new TypeError('no input')
        return this.#inner.decode(input)
      }
    }
    globalThis.TextDecoder = RefusesFatal as unknown as typeof TextDecoder
    const encoder = await mod.loadEncoder()
    expect(globalThis.TextDecoder).toBe(RefusesFatal)
    const fields = encoder.encode(INPUT)
    expect(privateEncodedFields.safeValidate(fields).success).toBe(true)
  })

  it('an invalid post is an input failure', async () => {
    const encoder = await mod.loadEncoder()
    // atproto has no floats; the shared encode step refuses one
    expect(() =>
      encoder.encode({
        ...INPUT,
        content: {text: 'x', embed: {$type: 'x', n: 1.5}},
      }),
    ).toThrow(mod.PrivateEncodeFailedError)
  })
})

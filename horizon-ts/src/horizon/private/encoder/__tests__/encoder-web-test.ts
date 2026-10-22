import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; blob CIDs need the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

/*
 * 2K design T-28 and T-26's memo: the web loader with the glue mocked and
 * the `.wasm` asset mapped to a URL string. The real glue is never loaded
 * here (T-27 would run it; see the 2K implementation log).
 */
const mockInit = jest.fn<(arg?: unknown) => Promise<object>>()
const mockPrepare =
  jest.fn<
    (
      did: string,
      nsid: string,
      rkey: string,
      contentJson: string,
      nowSecs: number,
    ) => string
  >()

jest.mock('../../../../../vendor/kryphocron-web/kryphocron_web.js', () => ({
  __esModule: true,
  default: (arg?: unknown) => mockInit(arg),
  initSync: () => {
    throw new Error('initSync is not used')
  },
  preparePrivatePost: (
    did: string,
    nsid: string,
    rkey: string,
    contentJson: string,
    nowSecs: number,
  ) => mockPrepare(did, nsid, rkey, contentJson, nowSecs),
}))

// The module is loaded in an isolated registry, so the logger is mocked, not spied on.
const mockWarn = jest.fn<(message: string, metadata?: unknown) => void>()
jest.mock('#/logger', () => ({
  logger: {
    warn: (message: string, metadata?: unknown) => mockWarn(message, metadata),
    error: () => {},
    info: () => {},
    debug: () => {},
    log: () => {},
  },
}))

const WASM_URL = '/assets/vendor/kryphocron-web/kryphocron_web_bg.0123abcd.wasm'
const WASM_PATH = '../../../../../vendor/kryphocron-web/kryphocron_web_bg.wasm'
jest.mock(
  '../../../../../vendor/kryphocron-web/kryphocron_web_bg.wasm',
  () => '/assets/vendor/kryphocron-web/kryphocron_web_bg.0123abcd.wasm',
)

import {lexToJson} from '@atproto/lex'

import {PP_COLLECTION} from '#/horizon/private/uri'
import {blob, BLOB_CID, DID, RECORD_CID} from '../../__tests__/fixtures'
import type * as WebEncoder from '../index.web'

type EncoderModule = typeof WebEncoder

/**
 * A fresh copy of the web module (its memo empty), with the asset mapped to
 * `asset.wasm` when given.
 */
function loadModule(asset?: {wasm: unknown}): EncoderModule {
  let mod: EncoderModule | undefined
  jest.isolateModules(() => {
    // doMock outlives the isolated registry, so every load sets it.
    jest.doMock(WASM_PATH, () => (asset ? asset.wasm : WASM_URL))
    mod = require('../index.web') as EncoderModule
  })
  return mod!
}

const RKEY = '3kencoderrkey2'
const NOW = 1_790_000_000

/** A JSON answer as the encoder gives it. */
function answer(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    encodedContent: {$bytes: 'AQID'},
    encodedContentCodec: 'codec/0.0',
    encodedContentGeneration: `codec/${String(NOW).padStart(20, '0')}/${'a'.repeat(64)}`,
    ...extra,
  })
}

const warn = mockWarn

beforeEach(() => {
  mockInit.mockReset()
  mockInit.mockResolvedValue({})
  mockPrepare.mockReset()
  mockPrepare.mockReturnValue(answer())
  mockWarn.mockReset()
})

describe('loading', () => {
  it('passes init the asset URL in the object form, never no argument', async () => {
    const {loadEncoder} = loadModule()
    await loadEncoder()
    expect(mockInit).toHaveBeenCalledTimes(1)
    expect(mockInit).toHaveBeenCalledWith({module_or_path: WASM_URL})
  })

  it('is memoized: one init for many calls', async () => {
    const {loadEncoder} = loadModule()
    const first = loadEncoder()
    expect(loadEncoder()).toBe(first)
    await first
    await loadEncoder()
    expect(mockInit).toHaveBeenCalledTimes(1)
  })

  it('a failed load is class load, and the next call loads again', async () => {
    const {loadEncoder, PrivateEncodeFailedError} = loadModule()
    mockInit.mockRejectedValueOnce(new Error('CompileError: secret detail'))
    const failure = await loadEncoder().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(PrivateEncodeFailedError)
    expect(
      (failure as InstanceType<typeof PrivateEncodeFailedError>).failureClass,
    ).toBe('load')
    expect((failure as Error).message).not.toContain('secret')
    expect((failure as Error).cause).toBeUndefined()

    await expect(loadEncoder()).resolves.toBeDefined()
    expect(mockInit).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['a number', 42],
    ['an object', {uri: WASM_URL}],
    ['undefined', undefined],
  ])(
    'the asset as %s is class load, with no init call',
    async (_label, wasm) => {
      const {loadEncoder} = loadModule({wasm})
      await expect(loadEncoder()).rejects.toMatchObject({
        name: 'PrivateEncodeFailedError',
        failureClass: 'load',
      })
      expect(mockInit).not.toHaveBeenCalled()
    },
  )

  it('encoderAvailable needs WebAssembly and crypto.getRandomValues', () => {
    const {encoderAvailable} = loadModule()
    expect(encoderAvailable()).toBe(true)

    const wasm = Object.getOwnPropertyDescriptor(globalThis, 'WebAssembly')!
    try {
      Object.defineProperty(globalThis, 'WebAssembly', {
        value: undefined,
        configurable: true,
      })
      expect(encoderAvailable()).toBe(false)
    } finally {
      Object.defineProperty(globalThis, 'WebAssembly', wasm)
    }

    const crypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!
    try {
      Object.defineProperty(globalThis, 'crypto', {
        value: {},
        configurable: true,
      })
      expect(encoderAvailable()).toBe(false)
    } finally {
      Object.defineProperty(globalThis, 'crypto', crypto)
    }
    expect(encoderAvailable()).toBe(true)
  })
})

describe('prewarm', () => {
  it('loads once, and a later load reuses it', async () => {
    const {prewarmEncoder, loadEncoder} = loadModule()
    prewarmEncoder()
    prewarmEncoder()
    await loadEncoder()
    expect(mockInit).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('a failure is logged by class only and forgotten', async () => {
    const {prewarmEncoder, loadEncoder} = loadModule()
    mockInit.mockRejectedValueOnce(new Error('secret detail'))
    prewarmEncoder()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('encoder: prewarm failed', {
      failureClass: 'load',
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret')

    await expect(loadEncoder()).resolves.toBeDefined()
    expect(mockInit).toHaveBeenCalledTimes(2)
  })
})

describe('encode', () => {
  it('calls the encoder with the DID, collection, rkey, content JSON and time', async () => {
    const {loadEncoder} = loadModule()
    const encoder = await loadEncoder()
    encoder.encode({did: DID, rkey: RKEY, content: {text: 'hi'}, nowSecs: NOW})
    expect(mockPrepare).toHaveBeenCalledTimes(1)
    expect(mockPrepare).toHaveBeenCalledWith(
      DID,
      PP_COLLECTION,
      RKEY,
      '{"text":"hi"}',
      NOW,
    )
  })

  it('writes BlobRefs as blob JSON, and leaves absent keys absent', async () => {
    const {loadEncoder} = loadModule()
    const encoder = await loadEncoder()
    const embed = {
      $type: 'tools.kryphocron.feed.postPublic#embedImage',
      images: [{image: blob(), alt: '', 'app.nearhorizon.spoiler': true}],
    }
    encoder.encode({
      did: DID,
      rkey: RKEY,
      content: {text: '', embed},
      nowSecs: NOW,
    })
    const content = JSON.parse(mockPrepare.mock.calls[0][3]) as {
      embed: {images: Record<string, unknown>[]}
    }
    expect(Object.keys(content)).toEqual(['text', 'embed'])
    expect(content.embed.images[0].image).toEqual({
      $type: 'blob',
      ref: {$link: BLOB_CID},
      mimeType: 'image/jpeg',
      size: 1000,
    })
    expect(content.embed.images[0]['app.nearhorizon.spoiler']).toBe(true)
  })

  it('returns the fields as lex values', async () => {
    const {loadEncoder} = loadModule()
    mockPrepare.mockReturnValue(
      answer({
        embedBlobs: [
          {
            $type: 'blob',
            ref: {$link: BLOB_CID},
            mimeType: 'image/jpeg',
            size: 1000,
          },
        ],
        mentionDids: [DID],
        quote: {
          uri: `at://${DID}/${PP_COLLECTION}/3kquoted22222`,
          cid: RECORD_CID,
        },
        mediaKinds: ['image'],
      }),
    )
    const encoder = await loadEncoder()
    const fields = encoder.encode({
      did: DID,
      rkey: RKEY,
      content: {text: 'hi'},
      nowSecs: NOW,
    })
    expect(fields.encodedContent).toBeInstanceOf(Uint8Array)
    expect(Array.from(fields.encodedContent)).toEqual([1, 2, 3])
    expect(fields.encodedContentCodec).toBe('codec/0.0')
    // A BlobRef, whose ref is a CID that lex-client writes back as blob JSON.
    expect(lexToJson(fields.embedBlobs ?? [])).toEqual([
      {
        $type: 'blob',
        ref: {$link: BLOB_CID},
        mimeType: 'image/jpeg',
        size: 1000,
      },
    ])
    expect(fields.mentionDids).toEqual([DID])
    expect(fields.mediaKinds).toEqual(['image'])
  })

  it('parses a mentionDids item that is not a DID (T-22)', async () => {
    const {loadEncoder} = loadModule()
    mockPrepare.mockReturnValue(answer({mentionDids: ['not a did']}))
    const encoder = await loadEncoder()
    expect(
      encoder.encode({did: DID, rkey: RKEY, content: {text: ''}, nowSecs: NOW})
        .mentionDids,
    ).toEqual(['not a did'])
  })

  it.each([
    ['an extra key', answer({text: 'clear'})],
    [
      'no encodedContent',
      JSON.stringify({encodedContentCodec: 'c', encodedContentGeneration: 'g'}),
    ],
    ['encodedContent as a string', answer({encodedContent: 'AQID'})],
    ['not JSON', 'not json'],
    ['an array', '[]'],
  ])('an answer with %s is class output', async (_label, result) => {
    const {loadEncoder} = loadModule()
    mockPrepare.mockReturnValue(result)
    const encoder = await loadEncoder()
    expect(() =>
      encoder.encode({did: DID, rkey: RKEY, content: {text: ''}, nowSecs: NOW}),
    ).toThrow(expect.objectContaining({failureClass: 'output'}))
  })

  it('an encoder throw is class encode, without its message', async () => {
    const {loadEncoder, PrivateEncodeFailedError} = loadModule()
    mockPrepare.mockImplementation(() => {
      throw new Error('malformed identity: secret detail')
    })
    const encoder = await loadEncoder()
    let failure: unknown
    try {
      encoder.encode({did: DID, rkey: RKEY, content: {text: ''}, nowSecs: NOW})
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(PrivateEncodeFailedError)
    expect(failure).toMatchObject({failureClass: 'encode'})
    expect((failure as Error).message).not.toContain('secret')
    expect((failure as Error).cause).toBeUndefined()
  })

  it('content lexToJson refuses is class input, with no encoder call (T-6)', async () => {
    /*
     * lexToJson passes a non-integer number through (only jsonToLex's strict
     * mode refuses one), so the refused value here is a bigint.
     */
    const {loadEncoder} = loadModule()
    const encoder = await loadEncoder()
    let failure: unknown
    try {
      encoder.encode({
        did: DID,
        rkey: RKEY,
        content: {
          text: '',
          embed: {$type: 'x.y#z', value: 12345678901234567890n} as never,
        },
        nowSecs: NOW,
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({failureClass: 'input'})
    expect((failure as Error).message).not.toContain('12345678901234567890')
    expect((failure as Error).cause).toBeUndefined()
    expect(mockPrepare).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it.each([
    ['a float', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an unsafe integer', 2 ** 60],
  ])(
    'content holding %s at any depth is class input, with no encoder call (2K-3, T-6)',
    async (_label, number) => {
      const {loadEncoder} = loadModule()
      const encoder = await loadEncoder()
      let failure: unknown
      try {
        encoder.encode({
          did: DID,
          rkey: RKEY,
          content: {
            text: 'hello',
            embed: {
              $type: 'tools.kryphocron.feed.postPublic#embedImage',
              images: [
                {
                  image: blob(),
                  alt: '',
                  aspectRatio: {width: number, height: 100},
                },
              ],
            },
          },
          nowSecs: NOW,
        })
      } catch (error) {
        failure = error
      }
      expect(failure).toMatchObject({failureClass: 'input'})
      expect((failure as Error).message).not.toContain(String(number))
      expect((failure as Error).cause).toBeUndefined()
      expect(mockPrepare).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
    },
  )

  it('integers anywhere in the content pass', async () => {
    const {loadEncoder} = loadModule()
    const encoder = await loadEncoder()
    encoder.encode({
      did: DID,
      rkey: RKEY,
      content: {
        text: 'hello',
        facets: [
          {
            index: {byteStart: 0, byteEnd: 5},
            features: [{$type: 'x.y#z'}],
          },
        ] as never,
      },
      nowSecs: NOW,
    })
    expect(mockPrepare).toHaveBeenCalledTimes(1)
  })
})

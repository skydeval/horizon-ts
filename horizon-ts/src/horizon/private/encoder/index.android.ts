/*
 * The client encoder on Android: kryphocron-web's encoder as plain
 * JavaScript (`kryphocron_web_bg.wasm2js.js`, made from the same .wasm by
 * binaryen's wasm2js), since Hermes has no WebAssembly. It runs through
 * `kryphocron_web_native.js`, the glue with its memory caches fixed for that
 * build. `scripts/kryphocron-native-check.mjs` proves its output byte-equal to
 * the .wasm's. This and `index.web.ts` are the only modules that import the
 * vendored package. iOS keeps `index.native.ts` (no encoder) until it is
 * tried there.
 */

import {getRandomValues} from 'expo-crypto'

import {logger} from '#/logger'
import {encodeWith, type PreparePrivatePost} from './encode'
import {
  encodeFailureClassOf,
  type Encoder,
  PrivateEncodeFailedError,
} from './types'

export * from './types'

/**
 * Always: the encoder is plain JavaScript, expo-crypto gives it a CSRNG, and
 * the outbox's run lock is held in the app itself (`outbox/locks.ts`).
 */
export function encoderAvailable(): boolean {
  return true
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
 * a failure is logged by class and forgotten.
 */
export function prewarmEncoder(): void {
  loadEncoder().catch((error: unknown) => {
    logger.warn('encoder: prewarm failed', {
      failureClass: encodeFailureClassOf(error),
    })
  })
}

type Globals = {
  crypto?: {getRandomValues?: unknown}
  TextDecoder?: unknown
  WebAssembly?: unknown
}

/**
 * The glue reads its CSRNG from `globalThis.crypto.getRandomValues`, which
 * Hermes lacks; expo-crypto's is the system's.
 */
function provideCrypto() {
  const g = globalThis as Globals
  if (typeof g.crypto?.getRandomValues === 'function') return
  g.crypto = Object.assign(g.crypto ?? {}, {
    getRandomValues: <T extends ArrayBufferView>(array: T): T => {
      getRandomValues(array as unknown as Uint8Array)
      return array
    },
  })
}

/**
 * The glue makes its decoder with `{fatal: true}` when it loads, which the
 * app's TextDecoder polyfill refuses. While it loads, a decoder that drops
 * the option stands in (the encoder only hands back valid UTF-8).
 */
async function withLenientTextDecoder<T>(run: () => Promise<T>): Promise<T> {
  const g = globalThis as Globals
  const Base = g.TextDecoder as
    | (new (
        label?: string,
        options?: object,
      ) => {
        decode(input?: ArrayBufferView): string
      })
    | undefined
  if (!Base) return run()
  try {
    new Base('utf-8', {ignoreBOM: true, fatal: true})
    return await run()
  } catch {
    // Refused: stand in below.
  }
  class LenientTextDecoder {
    #decoder = new Base!('utf-8')
    decode(input?: ArrayBufferView) {
      return input === undefined ? '' : this.#decoder.decode(input)
    }
  }
  g.TextDecoder = LenientTextDecoder
  try {
    return await run()
  } finally {
    g.TextDecoder = Base
  }
}

async function load(): Promise<Encoder> {
  let prepare: PreparePrivatePost
  try {
    provideCrypto()
    const [glue, module] = await withLenientTextDecoder(() =>
      Promise.all([
        import('../../../../vendor/kryphocron-web/kryphocron_web_native.js'),
        import('../../../../vendor/kryphocron-web/kryphocron_web_bg.wasm2js.js'),
      ]),
    )
    instantiateThroughGlue(glue.initSync, module.instantiate)
    prepare = glue.preparePrivatePost
  } catch {
    throw new PrivateEncodeFailedError('load')
  }
  return {encode: input => encodeWith(prepare, input)}
}

/**
 * The glue builds its instance with `new WebAssembly.Instance(module,
 * imports)`. For that one call, a stand-in WebAssembly hands it the
 * JavaScript module's exports over those same imports.
 */
function instantiateThroughGlue(
  initSync: (options: {module: unknown}) => unknown,
  instantiate: (
    imports: Record<string, Record<string, unknown>>,
  ) => Record<string, unknown>,
) {
  class Module {}
  class Instance {
    exports: Record<string, unknown>
    constructor(
      _module: Module,
      imports: Record<string, Record<string, unknown>>,
    ) {
      this.exports = instantiate(imports)
    }
  }
  const g = globalThis as Globals
  const had = 'WebAssembly' in g
  const real = g.WebAssembly
  g.WebAssembly = {Module, Instance}
  try {
    initSync({module: new Module()})
  } finally {
    if (had) g.WebAssembly = real
    else delete g.WebAssembly
  }
}

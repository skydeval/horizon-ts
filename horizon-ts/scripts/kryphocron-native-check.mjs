/* oxlint-disable import/no-nodejs-modules, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- a build-time Node tool over untyped generated and vendored modules */
/*
 * Checks the Android app's JavaScript build of kryphocron-web's encoder
 * against the .wasm: each input is encoded twice, once on the .wasm with its
 * own glue and once on kryphocron_web_bg.wasm2js.js with
 * kryphocron_web_native.js, with identical deterministic "random" bytes, and
 * every output (and every error) must be byte-identical. A stress run of 200
 * posts up to 20,000 characters grows memory several times.
 *
 *   node scripts/kryphocron-native-check.mjs
 *
 * See vendor/kryphocron-web/VERSION.md ("JavaScript build for native").
 */
import {readFileSync} from 'node:fs'

const VENDOR = new URL('../vendor/kryphocron-web/', import.meta.url)
const glueWasm = await import(new URL('kryphocron_web.js', VENDOR).href)
const glueJs = await import(new URL('kryphocron_web_native.js', VENDOR).href)
const {instantiate} = await import(
  new URL('kryphocron_web_bg.wasm2js.js', VENDOR).href
)
const wasmPath = new URL('kryphocron_web_bg.wasm', VENDOR)

// Deterministic CSRNG stand-in, reseeded before each encode.
let seed = 0
function reseed(n) {
  seed = n >>> 0
}
function nextByte() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed >>> 24
}
const fakeCrypto = {
  getRandomValues(array) {
    for (let i = 0; i < array.length; i++) array[i] = nextByte()
    return array
  },
}
Object.defineProperty(globalThis, 'crypto', {
  value: fakeCrypto,
  configurable: true,
})

// The real one.
await glueWasm.default({module_or_path: readFileSync(wasmPath)})

// The converted one, through a stand-in WebAssembly, as the app does.
const realWA = globalThis.WebAssembly
class Module {}
class Instance {
  constructor(_module, imports) {
    this.exports = instantiate(imports)
  }
}
globalThis.WebAssembly = {Module, Instance}
try {
  glueJs.initSync({module: new Module()})
} finally {
  globalThis.WebAssembly = realWA
}

const DID = 'did:plc:abcdefghijklmnopqrstuvwx'
const NSID = 'tools.kryphocron.feed.postPrivate'
const cases = [
  {text: ''},
  {text: 'hello'},
  {text: 'Boobs✨ 🌸 é ñ 日本 👩🏽‍💻 ' + 'x'.repeat(200)},
  {
    text: 'hi @alice.test look https://example.com',
    facets: [
      {
        index: {byteStart: 3, byteEnd: 14},
        features: [
          {
            $type: 'app.bsky.richtext.facet#mention',
            did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
          },
        ],
      },
      {
        index: {byteStart: 20, byteEnd: 39},
        features: [
          {$type: 'app.bsky.richtext.facet#link', uri: 'https://example.com'},
        ],
      },
    ],
  },
  {
    text: 'a picture',
    embed: {
      $type: 'app.bsky.embed.images',
      images: [
        {
          alt: 'a cat',
          image: {
            $type: 'blob',
            ref: {
              $link:
                'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
            },
            mimeType: 'image/jpeg',
            size: 12345,
          },
          aspectRatio: {width: 4, height: 3},
        },
      ],
    },
  },
  {
    text: 'quoting',
    embed: {
      $type: 'app.bsky.embed.record',
      record: {
        uri: 'at://did:plc:bbbbbbbbbbbbbbbbbbbbbbbb/app.bsky.feed.post/3kabcdefghijk',
        cid: 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm',
      },
    },
  },
  {text: 'long '.repeat(600)},
]

// Hide Node from getrandom's environment check, as on Hermes.
const realProcess = globalThis.process
let same = 0
let failed = 0
for (const [i, content] of cases.entries()) {
  for (const now of [1793000000, 1793205951]) {
    const rkey = `3m${i}abcdefghij`
    const args = [DID, NSID, rkey, JSON.stringify(content), now]
    Object.defineProperty(globalThis, 'process', {
      value: undefined,
      configurable: true,
      writable: true,
    })
    let a, b
    try {
      reseed(1000 + i)
      a = glueWasm.preparePrivatePost(...args)
      reseed(1000 + i)
      b = glueJs.preparePrivatePost(...args)
    } finally {
      Object.defineProperty(globalThis, 'process', {
        value: realProcess,
        configurable: true,
        writable: true,
      })
    }
    if (a === b) {
      same++
    } else {
      failed++
      console.log(
        'DIFFERENT',
        i,
        now,
        '\n',
        a.slice(0, 200),
        '\n',
        b.slice(0, 200),
      )
    }
  }
}
// Errors must match too.
for (const bad of [
  'not json',
  JSON.stringify({facets: []}),
  JSON.stringify({text: 1}),
]) {
  let ea, eb
  try {
    glueWasm.preparePrivatePost(DID, NSID, '3mbad', bad, 1793000000)
  } catch (e) {
    ea = String(e)
  }
  try {
    glueJs.preparePrivatePost(DID, NSID, '3mbad', bad, 1793000000)
  } catch (e) {
    eb = String(e)
  }
  if (ea && ea === eb) same++
  else {
    failed++
    console.log('ERROR DIFFERENT', bad, ea, eb)
  }
}
// Stress: many posts of random sizes and scripts, back to back, so memory
// grows several times mid-run.
const pieces = ['a', 'é', '日本', '🌸', '👩🏽‍💻', ' ', '\n', 'Ж', 'مرحبا', '™']
let rng = 7
const rand = n => (rng = (Math.imul(rng, 1103515245) + 12345) >>> 0) % n
const sizes = []
for (let i = 0; i < 200; i++) {
  const len = i % 10 === 0 ? 20000 : rand(4000)
  let text = ''
  while (text.length < len) text += pieces[rand(pieces.length)]
  const args = [DID, NSID, `3ms${i}`, JSON.stringify({text}), 1793000000 + i]
  Object.defineProperty(globalThis, 'process', {
    value: undefined,
    configurable: true,
    writable: true,
  })
  let a, b
  try {
    reseed(5000 + i)
    a = glueWasm.preparePrivatePost(...args)
    reseed(5000 + i)
    b = glueJs.preparePrivatePost(...args)
  } finally {
    Object.defineProperty(globalThis, 'process', {
      value: realProcess,
      configurable: true,
      writable: true,
    })
  }
  if (a === b) same++
  else {
    failed++
    console.log('STRESS DIFFERENT', i, len)
  }
  sizes.push(len)
}
console.log('stress sizes max', Math.max(...sizes))
console.log(`identical: ${same}, different: ${failed}`)
console.log(
  'sample',
  glueJs
    .preparePrivatePost(DID, NSID, '3msample', '{"text":"hi"}', 1793000000)
    .slice(0, 160),
)
process.exit(failed ? 1 : 0)

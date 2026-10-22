import {describe, expect, it} from '@jest/globals'

import committedProduction from '../../../../public/oauth-client-metadata.json'
import {
  checkPreviewOrigin,
  PAGES_HEADERS,
  PAGES_REDIRECTS,
  previewClientMetadata,
} from '../../../../scripts/horizon-preview-pages'
import {readPreviewOrigin} from '../../preview'
import {createPreviewClientMetadata} from '../oauth-metadata'

const ORIGINS = [
  'https://preview.example.invalid',
  'https://horizon-preview2.pages.dev',
  'https://nearhorizon.app',
  'https://preview.example.invalid:8443',
]

const NOT_ORIGINS = [
  '',
  'preview.example.invalid',
  'http://preview.example.invalid',
  'https://preview.example.invalid/',
  'https://preview.example.invalid/app',
  'https://preview.example.invalid?x=1',
  'https://Preview.Example.invalid',
  'https://user@preview.example.invalid',
]

describe('preview build packaging', () => {
  it('the build script writes the document the app signs in with', () => {
    for (const origin of ORIGINS) {
      expect(previewClientMetadata(committedProduction, origin)).toEqual(
        createPreviewClientMetadata(origin),
      )
    }
  })

  it('the build script and the app accept the same origins', () => {
    for (const origin of ORIGINS) {
      expect(checkPreviewOrigin(origin)).toBe(origin)
      expect(readPreviewOrigin('preview', origin)).toBe(origin)
    }
    for (const origin of NOT_ORIGINS) {
      expect(() => checkPreviewOrigin(origin)).toThrow()
      expect(readPreviewOrigin('preview', origin)).toBeUndefined()
    }
  })

  it('the app has a preview origin only in preview mode', () => {
    const origin = ORIGINS[0]
    expect(readPreviewOrigin(undefined, origin)).toBeUndefined()
    expect(readPreviewOrigin('production', origin)).toBeUndefined()
    expect(readPreviewOrigin('preview', undefined)).toBeUndefined()
  })

  it('every path that is not a file is the app', () => {
    expect(PAGES_REDIRECTS).toBe('/* /index.html 200\n')
  })

  it('the client document is readable cross-origin and not cached', () => {
    const block = PAGES_HEADERS.split('\n\n').find(b =>
      b.startsWith('/oauth-client-metadata.json\n'),
    )
    expect(block).toContain('Access-Control-Allow-Origin: *')
    expect(block).toContain('Cache-Control: no-cache')
  })

  it('the private post encoder is served as WebAssembly and cached for good', () => {
    const block = PAGES_HEADERS.split('\n\n').find(b =>
      b.startsWith('/assets/vendor/kryphocron-web/*\n'),
    )
    expect(block).toContain('Content-Type: application/wasm')
    expect(block).toContain(
      'Cache-Control: public, max-age=31536000, immutable',
    )
  })
})

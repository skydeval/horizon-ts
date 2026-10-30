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
    expect(PAGES_REDIRECTS.split('\n').at(-2)).toBe('/* /index.html 200')
  })

  it('/download goes to the Android download page, ahead of the app', () => {
    expect(PAGES_REDIRECTS.split('\n')[0]).toBe(
      '/download https://dl.nearhorizon.app/index.html 302',
    )
  })

  it('the client document is readable cross-origin and not cached', () => {
    const block = PAGES_HEADERS.split('\n\n').find(b =>
      b.startsWith('/oauth-client-metadata.json\n'),
    )
    expect(block).toContain('Access-Control-Allow-Origin: *')
    expect(block).toContain('Cache-Control: no-cache')
  })

  it('the app document is never stored, so it stays out of the back/forward cache', () => {
    const blocks = PAGES_HEADERS.split('\n\n')
    // `/`, `/index.html` and every deep path the fallback answers match `/*`.
    const every = blocks.find(b => b.startsWith('/*\n'))
    expect(every).toContain('Cache-Control: no-store')
    expect(blocks[0]).toBe(every)
    // Every other block is for files, never for the app's routes.
    const others = blocks.slice(1).map(b => b.split('\n')[0])
    expect(others).toEqual([
      '/oauth-client-metadata.json',
      '/_expo/static/*',
      '/assets/*',
      '/assets/vendor/kryphocron-web/*',
    ])
  })

  it('files keep their own caching, with the no-store detached first', () => {
    const blocks = PAGES_HEADERS.split('\n\n').slice(1)
    for (const block of blocks) {
      const lines = block.split('\n').map(line => line.trim())
      const detach = lines.indexOf('! Cache-Control')
      expect(detach).toBeGreaterThan(0)
      const set = lines.findIndex(line => line.startsWith('Cache-Control:'))
      if (set !== -1) expect(set).toBeGreaterThan(detach)
      expect(block).not.toContain('no-store')
    }
    const hashed = blocks.find(b => b.startsWith('/_expo/static/*\n'))
    expect(hashed).toContain(
      'Cache-Control: public, max-age=31536000, immutable',
    )
    const assets = blocks.find(b => b.startsWith('/assets/*\n'))
    expect(assets?.trim().split('\n')).toHaveLength(2)
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

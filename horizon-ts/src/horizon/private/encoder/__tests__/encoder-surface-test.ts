/* oxlint-disable import/no-nodejs-modules -- reads the vendored files as text, in jest only */
import fs from 'node:fs'
import path from 'node:path'

import {describe, expect, it} from '@jest/globals'

/*
 * 2K design T-15: the encoder's surface. The vendored files are read as
 * text, never loaded, so a refreshed build that exports a decoder or takes a
 * slug fails here.
 */

const ROOT = path.resolve(__dirname, '../../../../..')
const SRC = path.join(ROOT, 'src')
const VENDOR = path.join(ROOT, 'vendor', 'kryphocron-web')
const ENCODER_DIR = path.join(SRC, 'horizon', 'private', 'encoder')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

/** The value exports named by `export` statements and declarations. */
function exportNames(source: string): string[] {
  const names = new Set<string>()
  for (const [, name] of source.matchAll(
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/gm,
  )) {
    names.add(name)
  }
  if (/^export\s+default\b/m.test(source)) names.add('default')
  for (const [, list] of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const item of list.split(',')) {
      const parts = item.trim().split(/\s+as\s+/)
      const name = parts[parts.length - 1]?.trim()
      if (name) names.add(name)
    }
  }
  return [...names].sort()
}

describe('the encoder surface', () => {
  const files = sourceFiles(SRC)

  it('only private/encoder/ imports the vendored package', () => {
    // An import, a require or a jest mock of a path into the package.
    const imports =
      /(?:\bfrom\s+|\bimport\(\s*|\brequire\(\s*|\bjest\.(?:mock|doMock)\(\s*)['"][^'"]*vendor\/kryphocron-web/
    const outside = files.filter(
      file =>
        !file.startsWith(ENCODER_DIR + path.sep) &&
        imports.test(fs.readFileSync(file, 'utf8')),
    )
    expect(outside).toEqual([])
    // Guards the scan against passing for the wrong reason.
    expect(
      imports.test(
        fs.readFileSync(path.join(ENCODER_DIR, 'index.web.ts'), 'utf8'),
      ),
    ).toBe(true)
  })

  it('the module exports exactly default, initSync and preparePrivatePost', () => {
    const expected = ['default', 'initSync', 'preparePrivatePost']
    const glue = fs.readFileSync(path.join(VENDOR, 'kryphocron_web.js'), 'utf8')
    const types = fs.readFileSync(
      path.join(VENDOR, 'kryphocron_web.d.ts'),
      'utf8',
    )
    expect(exportNames(glue)).toEqual(expected)
    expect(exportNames(types)).toEqual(expected)
  })

  it('preparePrivatePost takes (did, nsid, rkey, content_json, now_secs)', () => {
    const types = fs.readFileSync(
      path.join(VENDOR, 'kryphocron_web.d.ts'),
      'utf8',
    )
    const match = /export function preparePrivatePost\(([^)]*)\)/.exec(types)
    const params = match?.[1]
      .split(',')
      .map(param => param.split(':')[0].trim())
    expect(params).toEqual(['did', 'nsid', 'rkey', 'content_json', 'now_secs'])
  })

  it('no file in src/ names the codec library', () => {
    // Spelled in two pieces so this file does not name it either.
    const name = new RegExp(['laq', 'una'].join(''), 'i')
    const naming = files.filter(file =>
      name.test(fs.readFileSync(file, 'utf8')),
    )
    expect(naming).toEqual([])
  })
})

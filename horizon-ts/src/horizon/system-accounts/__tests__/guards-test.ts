/* oxlint-disable import/no-nodejs-modules -- reads the sources as text, in jest only */
import * as fs from 'node:fs'
import * as path from 'node:path'

import {describe, expect, it} from '@jest/globals'

/*
 * Source guards (system accounts design 18 "No init or initRestore",
 * "Registration guard (SA-5)"): nothing under `src/horizon` restores the
 * OAuth library's "last" session by itself, and the registration never
 * reaches the switcher's sign-in paths.
 */

const HORIZON = path.join(__dirname, '..', '..')

function sources(dir: string): string[] {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : sources(full)
    }
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : []
  })
}

describe('source guards', () => {
  it('no `.init(` or `initRestore` under src/horizon; `initCallback` does not trip it', () => {
    const hits = sources(HORIZON).filter(file => {
      const text = fs.readFileSync(file, 'utf8')
      return /\.init\(/.test(text) || /initRestore/.test(text)
    })
    expect(hits).toEqual([])
    expect(/\.init\(/.test('client.initCallback(params)')).toBe(false)
  })

  it('the registration imports none of the switcher’s sign-in paths (SA-5)', () => {
    const dir = path.join(HORIZON, 'system-accounts')
    for (const file of sources(dir)) {
      // Code only: the headers say what the files never do.
      const text = fs
        .readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      for (const name of [
        'useHorizonSessionApi',
        'loginWithOAuth',
        'signInInThisTab',
        'savePendingSignIn',
        'OAuthSignInFields',
        'switched-to-account',
      ]) {
        expect({file: path.basename(file), has: text.includes(name)}).toEqual({
          file: path.basename(file),
          has: false,
        })
      }
    }
  })
})

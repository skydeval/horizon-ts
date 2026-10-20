import {type Facet, RichText} from '@bsky/sdk/richtext'
import {beforeEach, describe, expect, it} from '@jest/globals'
import {i18n} from '@lingui/core'

import {type app} from '#/lexicons'
import {withContentWarningRecord} from '../cw-line'
import {buildSpoilerLayout, rendersSpoilers} from '../layout'
import {detectLocalSpoilerFacets} from '../local'
import {
  MAX_OTHER_APP_SPOILERS,
  otherAppSpoilerPairs,
  otherAppSpoilerText,
  withOtherAppSpoilers,
} from '../other-apps'
import {
  otherAppSpoilersOn,
  setOtherAppSpoilersSetting,
} from '../other-apps-setting'
import {spoilerSafeText} from '../plain'
import {asPostText} from '../post-texts'

i18n.loadAndActivate({locale: 'en', messages: {}})

beforeEach(() => {
  setOtherAppSpoilersSetting(true)
})

/** The covered texts of a post text drawn with other apps' spoilers. */
function covered(text: string): string[] | undefined {
  const pairs = otherAppSpoilerPairs(text)
  if (!pairs) return undefined
  return pairs.map(([open, close]) => text.slice(open.end, close.start))
}

/** A post's text, as a post site builds it from its record. */
function postText(text: string, facets?: Facet[], record: unknown = {}) {
  return withContentWarningRecord(new RichText({text, facets}), record)
}

function spoilerTexts(richText: RichText): string[] {
  return buildSpoilerLayout(richText, {compact: false}).items.flatMap(item =>
    item.kind === 'run'
      ? item.parts.flatMap(part =>
          part.kind === 'spoiler' ? [part.richText.text] : [],
        )
      : [item.parts.map(part => part.richText.text).join('')],
  )
}

describe('the strict rule (true positives)', () => {
  it.each([
    ['the killer is ||Bob||', ['Bob']],
    ['||the whole post||', ['the whole post']],
    ['a ||b|| c ||d e||', ['b', 'd e']],
    ['(||x||), [||y||]!', ['x', 'y']],
    ['ending: ||Snape kills Dumbledore||.', ['Snape kills Dumbledore']],
    ['||\u{1F389} party|| tonight', ['\u{1F389} party']],
    ['cats && dogs, and ||the twist||', ['the twist']],
    ['||line one\nline two||', ['line one\nline two']],
  ])('%j covers %j', (text, expected) => {
    expect(covered(text)).toEqual(expected)
  })

  it(`allows ${MAX_OTHER_APP_SPOILERS} spoilers`, () => {
    const text = Array.from(
      {length: MAX_OTHER_APP_SPOILERS},
      (_, i) => `||s${i}||`,
    ).join(' ')
    expect(covered(text)).toHaveLength(MAX_OTHER_APP_SPOILERS)
  })
})

describe('the strict rule (false positives left alone)', () => {
  it.each([
    ['no markers', 'just a post'],
    ['a spaced operator', 'a || b'],
    ['spaces inside the markers', '|| x ||'],
    ['a space after the opening marker', '|| x||'],
    ['a space before the closing marker', '||x ||'],
    ['markers glued to words', 'true||false||null'],
    ['a word right after the closing marker', '||x||y'],
    ['a backtick', 'use `a || b` and ||x||'],
    ['a code span', '`||x||`'],
    ['two operators', 'a && b && ||c||'],
    ['an operator pair', 'x || y || ||z||'],
    ['three pipes', 'x ||| y ||z||'],
    ['an unpaired marker', '||a|| and ||'],
    ['an empty pair', '|||| text'],
    ['whitespace only', '||   ||'],
    ['an escaped marker', '\\||x||'],
    ['shell code', 'cmd1 || cmd2 && cmd3'],
    ['a block marker on its own line', '||\nsecret\n||'],
  ])('%s: %j', (_name, text) => {
    expect(covered(text)).toBeUndefined()
  })

  it(`more than ${MAX_OTHER_APP_SPOILERS} spoilers leaves the post alone`, () => {
    const text = Array.from(
      {length: MAX_OTHER_APP_SPOILERS + 1},
      (_, i) => `||s${i}||`,
    ).join(' ')
    expect(covered(text)).toBeUndefined()
  })
})

describe('withOtherAppSpoilers', () => {
  it('draws a post from another app with covers, markers hidden', () => {
    const shown = withOtherAppSpoilers(postText('the killer is ||Bob||'), true)
    expect(rendersSpoilers(shown)).toBe(true)
    expect(shown.text).toBe('the killer is ||Bob||')
    expect(spoilerTexts(shown)).toEqual(['Bob'])
    const layout = buildSpoilerLayout(shown, {compact: false})
    expect(
      layout.items.flatMap(item =>
        item.kind === 'run' ? item.parts.map(part => part.richText.text) : [],
      ),
    ).toEqual(['the killer is ', 'Bob'])
  })

  it('is stock with the setting off', () => {
    const richText = postText('the killer is ||Bob||')
    const shown = withOtherAppSpoilers(richText, false)
    expect(shown).toBe(richText)
    expect(rendersSpoilers(shown)).toBe(false)
  })

  it("leaves texts that are not a post's alone (bios, DMs)", () => {
    const bio = new RichText({text: 'I am ||secret||'})
    expect(withOtherAppSpoilers(bio, true)).toBe(bio)
  })

  it('leaves a post with spoiler facets as written', () => {
    const text = 'a ||b|| c'
    const own = postText(text, detectLocalSpoilerFacets(text))
    expect(withOtherAppSpoilers(own, true)).toBe(own)
  })

  it('leaves a post that fails the rule as stock', () => {
    const richText = postText('a || b')
    expect(withOtherAppSpoilers(richText, true)).toBe(richText)
  })

  it("keeps the record's facets outside the spoiler", () => {
    const text = 'see https://example.com ||ending||'
    const link: Facet = {
      index: {byteStart: 4, byteEnd: 23},
      features: [
        {$type: 'app.bsky.richtext.facet#link', uri: 'https://example.com'},
      ] as Facet['features'],
    }
    const shown = withOtherAppSpoilers(postText(text, [link]), true)
    expect(shown.facets).toContainEqual(link)
    expect(spoilerTexts(shown)).toEqual(['ending'])
  })

  it('returns one object per post text', () => {
    const richText = postText('||x||')
    expect(otherAppSpoilerText(richText)).toBe(otherAppSpoilerText(richText))
  })

  it('a DM share preview text is a post text too', () => {
    const shown = withOtherAppSpoilers(
      asPostText(new RichText({text: '||x||'})),
      true,
    )
    expect(rendersSpoilers(shown)).toBe(true)
  })
})

describe('the video card text', () => {
  const record = (text: string) =>
    ({
      $type: 'app.bsky.feed.post',
      text,
      createdAt: '2026-10-20T00:00:00.000Z',
    }) as app.bsky.feed.post.Main

  it('names the spoiler while the setting is on', () => {
    expect(otherAppSpoilersOn()).toBe(true)
    expect(spoilerSafeText(record('the killer is ||Bob||'))).toBe(
      'the killer is [spoiler]',
    )
  })

  it('is the record text with the setting off', () => {
    setOtherAppSpoilersSetting(false)
    expect(otherAppSpoilersOn()).toBe(false)
    expect(spoilerSafeText(record('the killer is ||Bob||'))).toBe(
      'the killer is ||Bob||',
    )
  })
})

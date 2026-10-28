import {beforeEach, describe, expect, it, jest} from '@jest/globals'

let mockMenuOn = true

jest.mock('#/horizon/switches', () =>
  Object.defineProperties(
    {...jest.requireActual<object>('#/horizon/switches')},
    {COMPOSER_AUDIENCE_MENU: {get: () => mockMenuOn, enumerable: true}},
  ),
)

import {type ThreadgateAllowUISetting} from '#/state/queries/threadgate/types'
import {type app} from '#/lexicons'
import {
  applyReplyChoice,
  audienceTriggerReads,
  canToggleReplyValue,
  hidesStockInteractionPill,
  interactionSummary,
  isInteractionDirty,
  quotesAllowed,
  withQuotesAllowed,
} from '../composer/interaction'

const ANYONE: ThreadgateAllowUISetting[] = [{type: 'everybody'}]
const NOBODY: ThreadgateAllowUISetting[] = [{type: 'nobody'}]
const DISABLE = {$type: 'app.bsky.feed.postgate#disableRule'} as const
const LIST_A = 'at://did:plc:a/app.bsky.graph.list/3ka'
const LIST_B = 'at://did:plc:a/app.bsky.graph.list/3kb'
const LIST_C = 'at://did:plc:a/app.bsky.graph.list/3kc'

function postgate(rules: unknown[] = []): app.bsky.feed.postgate.Main {
  return {
    $type: 'app.bsky.feed.postgate',
    post: 'at://did:plc:a/app.bsky.feed.post/3k',
    createdAt: '2026-10-15T12:00:00.000Z',
    embeddingRules: rules,
  } as unknown as app.bsky.feed.postgate.Main
}

beforeEach(() => {
  mockMenuOn = true
})

describe('applyReplyChoice (the stock form’s transitions)', () => {
  it('Anyone and Nobody replace everything', () => {
    const some: ThreadgateAllowUISetting[] = [
      {type: 'followers'},
      {type: 'list', list: LIST_A},
    ]
    expect(applyReplyChoice(some, {type: 'everybody'})).toEqual(ANYONE)
    expect(applyReplyChoice(some, {type: 'nobody'})).toEqual(NOBODY)
    expect(applyReplyChoice(NOBODY, {type: 'everybody'})).toEqual(ANYONE)
  })

  it.each(['followers', 'following', 'mention'] as const)(
    '%s turns on from Anyone and from Nobody, and off back to Anyone',
    value => {
      for (const start of [ANYONE, NOBODY]) {
        const on = applyReplyChoice(start, {type: 'toggle', value})
        expect(on).toEqual([{type: value}])
        expect(applyReplyChoice(on, {type: 'toggle', value})).toEqual(ANYONE)
      }
    },
  )

  it('keeps groups in the order followers, following, mention, then lists as checked', () => {
    let settings = ANYONE
    settings = applyReplyChoice(settings, {
      type: 'toggle',
      value: `list:${LIST_B}`,
    })
    settings = applyReplyChoice(settings, {type: 'toggle', value: 'mention'})
    settings = applyReplyChoice(settings, {
      type: 'toggle',
      value: `list:${LIST_A}`,
    })
    settings = applyReplyChoice(settings, {type: 'toggle', value: 'followers'})
    expect(settings).toEqual([
      {type: 'followers'},
      {type: 'mention'},
      {type: 'list', list: LIST_B},
      {type: 'list', list: LIST_A},
    ])
    settings = applyReplyChoice(settings, {type: 'toggle', value: 'mention'})
    expect(settings).toEqual([
      {type: 'followers'},
      {type: 'list', list: LIST_B},
      {type: 'list', list: LIST_A},
    ])
  })

  it('refuses a sixth value and lets a checked value be removed', () => {
    const five: ThreadgateAllowUISetting[] = [
      {type: 'followers'},
      {type: 'following'},
      {type: 'mention'},
      {type: 'list', list: LIST_A},
      {type: 'list', list: LIST_B},
    ]
    expect(
      applyReplyChoice(five, {type: 'toggle', value: `list:${LIST_C}`}),
    ).toBe(five)
    expect(canToggleReplyValue(five, `list:${LIST_C}`)).toBe(false)
    expect(canToggleReplyValue(five, 'followers')).toBe(true)
    expect(
      applyReplyChoice(five, {type: 'toggle', value: 'followers'}),
    ).toEqual(five.slice(1))
    expect(canToggleReplyValue(ANYONE, 'mention')).toBe(true)
  })
})

describe('interaction summary and defaults', () => {
  it('"Anyone can interact" exactly when anyone can reply and quotes are allowed', () => {
    expect(interactionSummary(ANYONE, postgate())).toBe('anyone')
    expect(interactionSummary(ANYONE, undefined)).toBe('anyone')
    expect(interactionSummary(ANYONE, postgate([DISABLE]))).toBe('limited')
    expect(interactionSummary(NOBODY, postgate())).toBe('limited')
    expect(interactionSummary([{type: 'mention'}], postgate())).toBe('limited')
  })

  it('quotes toggle as the stock form writes them', () => {
    expect(quotesAllowed(postgate())).toBe(true)
    const off = withQuotesAllowed(postgate(), false)
    expect(off.embeddingRules).toEqual([DISABLE])
    expect(quotesAllowed(off)).toBe(false)
    expect(withQuotesAllowed(off, true).embeddingRules).toEqual([])
  })

  it('is dirty exactly when the stock comparison says so', () => {
    for (const prefs of [undefined, {}]) {
      expect(isInteractionDirty(prefs, ANYONE, postgate())).toBe(false)
      expect(isInteractionDirty(prefs, NOBODY, postgate())).toBe(true)
      expect(isInteractionDirty(prefs, ANYONE, postgate([DISABLE]))).toBe(true)
    }
    const saved = {
      threadgateAllowRules: [
        {$type: 'app.bsky.feed.threadgate#mentionRule' as const},
      ],
      postgateEmbeddingRules: [DISABLE],
    }
    expect(
      isInteractionDirty(saved, [{type: 'mention'}], postgate([DISABLE])),
    ).toBe(false)
    expect(isInteractionDirty(saved, ANYONE, postgate([DISABLE]))).toBe(true)
    expect(isInteractionDirty(saved, [{type: 'mention'}], postgate())).toBe(
      true,
    )
    expect(
      isInteractionDirty(
        {threadgateAllowRules: [], postgateEmbeddingRules: []},
        NOBODY,
        postgate(),
      ),
    ).toBe(false)
  })

  it('the stock pill is hidden for both visibilities with the menu on, and only while Private with it off', () => {
    expect(hidesStockInteractionPill(false)).toBe(true)
    expect(hidesStockInteractionPill(true)).toBe(true)
    mockMenuOn = false
    expect(hidesStockInteractionPill(false)).toBe(false)
    expect(hidesStockInteractionPill(true)).toBe(true)
  })
})

describe('the drop-down trigger', () => {
  it('a public post reads the interaction summary', () => {
    expect(
      audienceTriggerReads({isPrivate: false, hasReplySection: true}),
    ).toBe('summary')
    expect(
      audienceTriggerReads({isPrivate: false, hasReplySection: false}),
    ).toBe('summary')
  })

  it('a private post reads the summary and its audience (skydeval, 2026-10-27)', () => {
    expect(audienceTriggerReads({isPrivate: true, hasReplySection: true})).toBe(
      'both',
    )
  })

  it('reads the audience alone with no reply section or none chosen yet', () => {
    expect(
      audienceTriggerReads({isPrivate: true, hasReplySection: false}),
    ).toBe('audience')
    expect(
      audienceTriggerReads({
        isPrivate: true,
        hasReplySection: true,
        audiencePicked: false,
      }),
    ).toBe('audience')
  })
})

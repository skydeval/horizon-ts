import {beforeEach, describe, expect, it, jest} from '@jest/globals'

let mockContentWarnings = true
jest.mock('#/horizon/switches', () =>
  Object.defineProperties(
    {...jest.requireActual<object>('#/horizon/switches')},
    {CONTENT_WARNINGS: {get: () => mockContentWarnings, enumerable: true}},
  ),
)
// Only `getLabelStrings` is used; the preferences tree needs native modules.
jest.mock('#/state/preferences', () => ({useLabelDefinitions: () => ({})}))

import {interpretLabelValueDefinition} from '@bsky/sdk/moderation'
import {i18n, type MessageDescriptor} from '@lingui/core'

import {getLabelStrings} from '#/lib/moderation/useLabelInfo'
import {horizonGlobalLabelStrings, horizonLabelStrings} from '../label-strings'
import {CW_SELF_LABEL} from '../nsid'

i18n.loadAndActivate({locale: 'en', messages: {}})

beforeEach(() => {
  mockContentWarnings = true
})

const _ = (descriptor: MessageDescriptor) => i18n._(descriptor)

/** The definition the stock lookup falls back to for a self-label. */
function selfLabelDef(val: string) {
  return interpretLabelValueDefinition(
    {
      identifier: val,
      severity: 'none',
      blurs: 'none',
      defaultSetting: 'ignore',
      locales: [],
    },
    'did:plc:author',
  )
}

describe('the CW self-label in the labels UI', () => {
  it('reads "Content warning" through the stock lookup', () => {
    const strings = getLabelStrings(
      'en',
      horizonGlobalLabelStrings(_),
      selfLabelDef(CW_SELF_LABEL),
    )
    expect(strings).toEqual({
      lang: 'en',
      name: 'Content warning',
      description: 'The author put this post behind a content warning.',
    })
  })

  it('leaves other labels as stock', () => {
    const strings = getLabelStrings(
      'en',
      horizonGlobalLabelStrings(_),
      selfLabelDef('some-label'),
    )
    expect(strings).toEqual({
      lang: 'en',
      name: 'some-label',
      description: 'Labeled "some-label"',
    })
    expect(
      horizonLabelStrings('en', horizonGlobalLabelStrings(_), {
        identifier: 'porn',
      }),
    ).toBeUndefined()
  })

  it('a definition with its own strings keeps them', () => {
    const def = interpretLabelValueDefinition(
      {
        identifier: CW_SELF_LABEL,
        severity: 'none',
        blurs: 'none',
        defaultSetting: 'ignore',
        locales: [{lang: 'en', name: 'Own name', description: 'Own text'}],
      },
      'did:plc:labeler',
    )
    expect(getLabelStrings('en', horizonGlobalLabelStrings(_), def).name).toBe(
      'Own name',
    )
  })

  it('with CONTENT_WARNINGS off: the raw value, as stock', () => {
    mockContentWarnings = false
    expect(horizonGlobalLabelStrings(_)).toEqual({})
    const strings = getLabelStrings(
      'en',
      horizonGlobalLabelStrings(_),
      selfLabelDef(CW_SELF_LABEL),
    )
    expect(strings.name).toBe(CW_SELF_LABEL)
    expect(strings.description).toBe(`Labeled "${CW_SELF_LABEL}"`)
  })
})

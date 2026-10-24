import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * Phase 5 design 9, 13 ("Private"), B-11's 5B part: a kryphocron post's
 * fronters, carried in the clear, are copied by `toBskyRecord` into the
 * stock shape only while prism lists `plural.fronters`, and only a value
 * that reads as fronters; the stand-in card names no author and so shows
 * no fronters.
 */

let mockFrontersServed = false

jest.mock('#/horizon/private/server-support', () =>
  Object.defineProperties(
    {...jest.requireActual<object>('#/horizon/private/server-support')},
    {
      // A read-time decision: the function stands in for the feature store.
      pluralFrontersServed: {
        value: () => mockFrontersServed,
        enumerable: true,
      },
    },
  ),
)
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  useTheme: () => ({
    atoms: new Proxy({}, {get: () => ({})}),
    palette: new Proxy({}, {get: () => '#000'}),
  }),
}))
jest.mock('#/screens/PostThread/const', () => ({OUTER_SPACE: 16}))
jest.mock('#/components/Typography', () => {
  const {Text} = jest.requireActual<{
    Text: React.ComponentType<Record<string, unknown>>
  }>('react-native')
  return {Text: (props: Record<string, unknown>) => <Text {...props} />}
})
jest.mock('#/components/Button', () => ({
  Button: () => null,
  ButtonText: () => null,
}))
jest.mock('#/components/icons/Lock', () => ({
  Lock_Stroke2_Corner0_Rounded: () => null,
}))

import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {render, screen} from '@testing-library/react-native'

import {PLURAL_FRONTERS_KEY} from '#/horizon/lexicons/nearhorizon'
import {toBskyRecord} from '#/horizon/private/adapt/record'
import {StandIn} from '#/horizon/private/render/StandIn'
import {readFronters} from '../fronters'
import {SPARROW, WREN} from './harness'

i18n.loadAndActivate({locale: 'en', messages: {}})

const AUDIENCE = 'at://did:plc:authoraaaaaaaaaaaaaaaaaa/tools.kryphocron.graph.audience/3m4kq9aud2222'

function privateRecord(extra: Record<string, unknown> = {}) {
  return {
    $type: 'tools.kryphocron.feed.postPrivate',
    text: 'just us',
    createdAt: '2026-10-24T12:00:00.000Z',
    audienceList: AUDIENCE,
    ...extra,
  }
}

const fronters = {members: [{id: SPARROW}, {id: WREN}]}

beforeEach(() => {
  mockFrontersServed = false
})

describe('toBskyRecord and the fronters key (B-11)', () => {
  it('copies the key while prism serves plural.fronters', () => {
    mockFrontersServed = true
    const adapted = toBskyRecord(
      privateRecord({[PLURAL_FRONTERS_KEY]: fronters}),
    )
    expect(adapted).toMatchObject({[PLURAL_FRONTERS_KEY]: fronters})
    expect(readFronters(adapted)).toEqual([WREN, SPARROW])
  })

  it('drops it where prism does not list the feature', () => {
    const adapted = toBskyRecord(
      privateRecord({[PLURAL_FRONTERS_KEY]: fronters}),
    )
    expect(adapted).not.toHaveProperty([PLURAL_FRONTERS_KEY])
    expect(readFronters(adapted)).toBeNull()
  })

  it('drops a value that does not read as fronters', () => {
    mockFrontersServed = true
    for (const bad of [{members: []}, {members: [{id: 'not an rkey!'}]}, 'x']) {
      const adapted = toBskyRecord(privateRecord({[PLURAL_FRONTERS_KEY]: bad}))
      expect(adapted).not.toHaveProperty([PLURAL_FRONTERS_KEY])
    }
  })

  it('adds nothing to a record without the key', () => {
    mockFrontersServed = true
    expect(toBskyRecord(privateRecord())).toEqual({
      $type: 'app.bsky.feed.post',
      text: 'just us',
      createdAt: '2026-10-24T12:00:00.000Z',
    })
  })
})

describe('the stand-in (9)', () => {
  it('names no author, so it shows no fronters', () => {
    render(
      <I18nProvider i18n={i18n}>
        <StandIn />
      </I18nProvider>,
    )
    expect(screen.getByTestId('privatePostStandIn')).toBeTruthy()
    expect(screen.queryByText(/Wren|Sparrow|&/)).toBeNull()
  })
})

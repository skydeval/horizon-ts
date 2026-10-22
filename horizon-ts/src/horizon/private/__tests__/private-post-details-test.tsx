import {describe, expect, it, jest} from '@jest/globals'
import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {render} from '@testing-library/react-native'

let mockLabel: string | undefined

jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  useTheme: () => ({
    atoms: new Proxy({}, {get: () => ({})}),
    palette: new Proxy({}, {get: () => '#000'}),
  }),
}))
jest.mock('#/components/Typography', () => {
  const {Text} =
    jest.requireActual<typeof import('react-native')>('react-native')
  return {Text}
})
jest.mock('#/horizon/private/render/PrivateBadge', () => {
  const {View} =
    jest.requireActual<typeof import('react-native')>('react-native')
  return {PrivateMark: () => <View testID="privateMark" />}
})
jest.mock('#/horizon/private/render/controls', () => ({
  isPrivateDisplay: (uri: string | undefined) =>
    !!uri && uri.includes('postPrivate'),
}))
jest.mock('#/lib/lexClient', () => ({createLexClient: () => ({})}))
jest.mock('#/state/queries', () => ({STALE: {HOURS: {ONE: 0}}}))
jest.mock('#/state/queries/pds-detection', () => ({
  resolvePdsForIdentifier: () => Promise.resolve(undefined),
}))
jest.mock('#/state/queries/profile', () => ({
  useProfileQuery: () => ({data: undefined}),
}))
jest.mock('#/state/session', () => ({
  useSession: () => ({currentAccount: undefined}),
}))
jest.mock('#/state/session/network', () => ({networkAwareFetch: fetch}))
jest.mock('#/horizon/private/api/audiences', () => ({
  labelsFromServedAudience: () => false,
  postAudienceLabel: () => mockLabel,
  readAudienceRecordAt: () => Promise.resolve(undefined),
}))
jest.mock('#/horizon/private/audiences/useAudiencesQuery', () => ({
  useAudiencesQuery: () => ({data: undefined}),
}))
jest.mock('#/horizon/private/store', () => ({
  usePrivatePostFacts: () => ({}),
}))
jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({data: undefined}),
}))

import {PrivatePostDetails} from '#/horizon/private/render/AudienceLabel'

i18n.loadAndActivate({locale: 'en', messages: {}})

const DID = 'did:plc:authorrrrrrrrrrrrrrrrrrr'
const PRIVATE_URI = `at://${DID}/tools.kryphocron.feed.postPrivate/3kprivate`
const PUBLIC_URI = `at://${DID}/app.bsky.feed.post/3kpublic`

function renderDetails(uri: string) {
  return render(
    <I18nProvider i18n={i18n}>
      <PrivatePostDetails post={{uri}} />
    </I18nProvider>,
  )
}

type Node = ReturnType<ReturnType<typeof render>['getByTestId']>

function isHostText(n: Node) {
  return (n.type as unknown) === 'Text'
}

/** The row's children, as text or the mark's testID, in order. */
function rowParts(row: Node) {
  return row
    .findAll(
      n =>
        (typeof n.type === 'string' && n.props.testID === 'privateMark') ||
        isHostText(n),
    )
    .map(n =>
      n.props.testID === 'privateMark'
        ? 'lock'
        : [n.props.children].flat().join(''),
    )
}

describe('the thread anchor private details', () => {
  it('a dot separates the date from the lock, then the audience', () => {
    mockLabel = 'Horizon members'
    const row = renderDetails(PRIVATE_URI).getByTestId('privatePostDetails')
    expect(rowParts(row)).toEqual(['·', 'lock', '·', 'Horizon members'])
  })

  it('while the label loads: the dot and the lock', () => {
    mockLabel = undefined
    const row = renderDetails(PRIVATE_URI).getByTestId('privatePostDetails')
    expect(rowParts(row)).toEqual(['·', 'lock'])
  })

  it('the dots are hidden from screen readers', () => {
    mockLabel = 'Horizon members'
    const row = renderDetails(PRIVATE_URI).getByTestId('privatePostDetails')
    const dots = row.findAll(n => isHostText(n) && n.props.children === '·')
    expect(dots).toHaveLength(2)
    for (const dot of dots) {
      expect(dot.props.accessible).toBe(false)
      expect(dot.props.importantForAccessibility).toBe('no')
    }
  })

  it('a public post draws nothing, so its meta line is unchanged', () => {
    const {queryByTestId, toJSON} = renderDetails(PUBLIC_URI)
    expect(queryByTestId('privatePostDetails')).toBeNull()
    expect(toJSON()).toBeNull()
  })
})

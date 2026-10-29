import {Text} from 'react-native'
import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {render} from '@testing-library/react-native'

import {Provider, useAgeAssurance} from '#/ageAssurance'
import {type AgeCheck} from '#/horizon/age-checks'
import type * as DecideModule from '#/horizon/age-checks/decide'

/*
 * The app's age check drives the context Bluesky's screens read: a block is
 * access `None` (the shell's blocked screen); anything short of an adult
 * locks adult content off; chat stays on. No check: the defaults.
 */

let mockCheck: AgeCheck | null = null
const mockOnLaunch = jest.fn()

jest.mock('#/horizon/age-checks', () => {
  const decide = jest.requireActual<typeof DecideModule>(
    '#/horizon/age-checks/decide',
  )
  return {
    blocksApp: decide.blocksApp,
    locksAdultContent: decide.locksAdultContent,
    useAgeCheck: () => mockCheck,
    useAgeCheckOnLaunch: (active: boolean) => mockOnLaunch(active),
  }
})
// Bluesky's own provider (off in Horizon) and what it pulls in
jest.mock('#/ageAssurance/data', () => ({
  AgeAssuranceServerDataProvider: () => null,
  useAgeAssuranceServerDataContext: () => ({}),
}))
jest.mock('#/ageAssurance/state', () => ({
  useAgeAssuranceState: () => ({}),
  useOnAgeAssuranceAccessUpdate: () => {},
}))
jest.mock('#/ageAssurance/util', () => ({
  computeAgeAssuranceFlags: () => ({}),
  useAgeAssuranceRegionConfigWithFallback: () => undefined,
}))
jest.mock('#/lib/notifications/notifications', () => ({
  useGetAndRegisterPushToken: () => () => Promise.resolve(),
}))
jest.mock('#/ageAssurance/components/RedirectOverlay', () => ({
  Provider: ({children}: {children: React.ReactNode}) => children,
}))

function Probe() {
  const aa = useAgeAssurance()
  return (
    <Text>
      {`${aa.state.access} adult:${aa.flags.adultContentDisabled} chat:${aa.flags.chatDisabled}`}
    </Text>
  )
}

const TX = {regionCode: 'TX', name: 'Texas', law: '', from: '2026-01-01'}

function show() {
  return render(
    <Provider>
      <Probe />
    </Provider>,
  )
}

describe('the age assurance context in the app', () => {
  beforeEach(() => {
    mockCheck = null
    mockOnLaunch.mockReset()
  })

  it('no check applies: full access, nothing locked, no launch check', () => {
    expect(show().getByText('full adult:false chat:false')).toBeTruthy()
    expect(mockOnLaunch).toHaveBeenLastCalledWith(false)
  })

  it('a teen: adult content locked, chat untouched', () => {
    mockCheck = {region: TX, outcome: 'teen', checking: false}
    expect(show().getByText('full adult:true chat:false')).toBeTruthy()
    expect(mockOnLaunch).toHaveBeenLastCalledWith(true)
  })

  it('an adult: open', () => {
    mockCheck = {region: TX, outcome: 'open', checking: false}
    expect(show().getByText('full adult:false chat:false')).toBeTruthy()
  })

  it('under 13: no access', () => {
    mockCheck = {region: TX, outcome: 'under13', checking: false}
    expect(show().getByText('none adult:true chat:false')).toBeTruthy()
  })
})

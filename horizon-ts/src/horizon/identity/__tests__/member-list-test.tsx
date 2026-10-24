import {beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * Phase 5 design 6.2, the member list's "Edit" button (B-8): shown only
 * when the caller passes `onEdit` (one's own system, see profile-test),
 * and pressing it closes the list first, then opens Edit Profile, as the
 * dialog footgun asks (`control.close(() => ...)`). The design system is
 * replaced by plain views.
 */

const mockCloses: string[] = []
jest.mock('#/components/Dialog', () => {
  const {View} = jest.requireActual<{
    View: React.ComponentType<Record<string, unknown>>
  }>('react-native')
  return {
    Outer: (props: {children?: React.ReactNode}) => (
      <View>{props.children}</View>
    ),
    Handle: () => null,
    Close: () => null,
    ScrollableInner: (props: {children?: React.ReactNode}) => (
      <View>{props.children}</View>
    ),
    useDialogContext: () => ({
      close: (after?: () => void) => {
        mockCloses.push('close')
        after?.()
      },
    }),
  }
})
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  web: () => ({}),
  useTheme: () => ({
    atoms: new Proxy({}, {get: () => ({})}),
    palette: new Proxy({}, {get: () => '#000'}),
  }),
}))
jest.mock('#/components/Typography', () => {
  const {Text} = jest.requireActual<{
    Text: React.ComponentType<Record<string, unknown>>
  }>('react-native')
  return {Text: (props: Record<string, unknown>) => <Text {...props} />}
})
jest.mock('#/components/Button', () => {
  const {Pressable, Text} = jest.requireActual<{
    Pressable: React.ComponentType<Record<string, unknown>>
    Text: React.ComponentType<Record<string, unknown>>
  }>('react-native')
  return {
    Button: (props: {
      label: string
      onPress?: () => void
      testID?: string
      children?: React.ReactNode
    }) => (
      <Pressable
        accessibilityLabel={props.label}
        accessibilityHint=""
        onPress={props.onPress}
        testID={props.testID}>
        {props.children}
      </Pressable>
    ),
    ButtonText: (props: {children?: React.ReactNode}) => (
      <Text>{props.children}</Text>
    ),
  }
})
jest.mock('#/view/com/util/UserAvatar', () => ({UserAvatar: () => null}))
jest.mock('#/horizon/identity/FronterName', () => ({MemberSwatch: () => null}))

import {moderateProfile, type ModerationOpts} from '@bsky/sdk/moderation'
import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {fireEvent, render, screen} from '@testing-library/react-native'

import {type PluralProfile} from '../hooks'
import {MemberListDialog} from '../MemberListDialog'
import {parseMember, parseSystem} from '../parse'
import {AUTHOR, records, WREN} from './harness'

i18n.loadAndActivate({locale: 'en', messages: {}})

const moderationOpts: ModerationOpts = {
  userDid: undefined,
  prefs: {
    adultContentEnabled: false,
    labels: {},
    labelers: [],
    mutedWords: [],
    hiddenPosts: [],
  },
  labelDefs: {},
}

const plural: PluralProfile = {
  isSystem: true,
  system: parseSystem(records.system()) ?? undefined,
  front: null,
  engaging: [],
  members: {
    members: [{rkey: WREN, value: parseMember(records.member('Wren'))!}],
    partial: false,
  },
}

function list(onEdit?: () => void) {
  return render(
    <I18nProvider i18n={i18n}>
      <MemberListDialog
        control={{} as never}
        did={AUTHOR}
        profile={plural}
        moderation={moderateProfile(
          {did: AUTHOR, handle: 'flock.example'} as never,
          moderationOpts,
        )}
        onEdit={onEdit}
      />
    </I18nProvider>,
  )
}

beforeEach(() => {
  mockCloses.length = 0
})

describe('the member list`s Edit (6.2)', () => {
  it('shows Edit when given onEdit, and closes the list before opening Edit Profile', () => {
    const order: string[] = []
    list(() => {
      order.push(...mockCloses, 'edit')
    })
    expect(screen.getAllByTestId('pluralMemberRow')).toHaveLength(1)
    fireEvent.press(screen.getByTestId('pluralMemberListEdit'))
    expect(order).toEqual(['close', 'edit'])
  })

  it('shows no Edit without onEdit (another account`s system)', () => {
    list()
    expect(screen.getAllByTestId('pluralMemberRow')).toHaveLength(1)
    expect(screen.queryByTestId('pluralMemberListEdit')).toBeNull()
  })
})

import {afterEach, describe, expect, it, jest} from '@jest/globals'
import {act, render} from '@testing-library/react-native'

/*
 * The control's own collaborators are replaced by plain stand-ins: these
 * tests are about who owns the visibility record, not about how the control
 * looks.
 */
jest.mock('#/state/session', () => ({
  useSession: () => ({
    currentAccount: {did: 'did:plc:privateaaaaaaaaaaaaaaaaa'},
  }),
}))
jest.mock('#/alf', () => ({
  useBreakpoints: () => ({gtPhone: true}),
  atoms: new Proxy({}, {get: () => ({})}),
  useTheme: () => ({
    atoms: new Proxy({}, {get: () => ({})}),
    palette: new Proxy({}, {get: () => '#000'}),
  }),
}))
jest.mock('#/components/Button', () => ({
  Button: (props: {children?: React.ReactNode}) => props.children ?? null,
  ButtonIcon: () => null,
  ButtonText: () => null,
}))
jest.mock('#/components/Dialog', () => ({
  useDialogControl: () => ({open: () => {}, close: () => {}}),
}))
jest.mock('#/components/forms/SegmentedControl', () => ({
  Root: (props: {children?: React.ReactNode}) => props.children ?? null,
  Item: (props: {children?: React.ReactNode}) => props.children ?? null,
  ItemText: () => null,
}))
jest.mock('#/components/Menu', () => ({
  Root: (props: {children?: React.ReactNode}) => props.children ?? null,
  Trigger: () => null,
  Outer: (props: {children?: React.ReactNode}) => props.children ?? null,
  Group: (props: {children?: React.ReactNode}) => props.children ?? null,
  Item: (props: {children?: React.ReactNode}) => props.children ?? null,
  ItemText: () => null,
  ItemIcon: () => null,
  ItemRadio: () => null,
  Divider: () => null,
}))
jest.mock('#/components/Typography', () => ({
  Text: () => null,
}))
jest.mock('#/components/icons/Chevron', () => ({
  TinyChevronBottom_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/components/icons/Globe', () => ({
  Earth_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/components/icons/List', () => ({
  ListPlus_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/components/icons/Lock', () => ({
  Lock_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/components/icons/Person', () => ({
  Person_Stroke2_Corner0_Rounded: () => null,
  PersonGroup_Stroke2_Corner2_Rounded: () => null,
}))
const mockAudienceMenu = jest.fn((_props: Record<string, unknown>) => null)
jest.mock('#/horizon/private/composer/AudienceMenu', () => ({
  AudienceMenu: (props: Record<string, unknown>) => mockAudienceMenu(props),
}))
jest.mock('#/horizon/private/composer/useReplyAnchor', () => ({
  useReplyAnchor: () => undefined,
}))
jest.mock('#/state/queries/preferences', () => ({
  usePreferencesQuery: () => ({data: undefined}),
}))
jest.mock('#/state/queries/post-interaction-settings', () => ({
  usePostInteractionSettingsMutation: () => ({mutate: () => {}}),
}))
jest.mock('#/horizon/private/audiences/AudienceEditorDialog', () => ({
  AudienceEditorDialog: () => null,
}))
jest.mock('#/horizon/private/audiences/useAudiencesQuery', () => ({
  useAudiencesQuery: () => ({data: []}),
}))
jest.mock('#/horizon/private/membership', () => ({
  useIsMember: () => true,
  useIsConfirmedMember: () => true,
}))
jest.mock('#/horizon/private/render/AudienceLabel', () => ({
  usePostAudienceLabel: () => undefined,
}))
let mockDefaults: PrivateDefaults | undefined
jest.mock('#/horizon/private/defaults/compose', () => ({
  usePrivateComposeDefaults: () => mockDefaults,
}))
jest.mock('@lingui/react', () => ({
  useLingui: () => ({
    _: (value: {message?: string; id?: string}) => value.message ?? value.id,
  }),
  Trans: () => null,
}))

import {type PrivateDefaults} from '#/horizon/private/defaults/record'
import {usePrivateComposeSession} from '../composer/session'
import {
  chooseComposeVisibility,
  getComposeVisibility,
  initialComposeVisibility,
  PUBLIC_COMPOSE,
  setComposeVisibility,
} from '../composer/state'
import {
  ComposerAudiencePill,
  ComposerAudienceProvider,
  ComposerAudienceRow,
  ComposerAudienceSlot,
  useShowsComposerAudiencePill,
} from '../composer/VisibilityControl'

const DID = 'did:plc:privateaaaaaaaaaaaaaaaaa'
const PRIVATE_PARENT = `at://did:plc:otherbbbbbbbbbbbbbbbbbbbb/tools.kryphocron.feed.postPrivate/3kparent2222`
const PUBLIC_PARENT = `at://${DID}/app.bsky.feed.post/3kpublic22222`
const thread = {posts: [], postgate: {}, threadgate: []} as never

let pillShown: boolean | undefined

function PillProbe() {
  pillShown = useShowsComposerAudiencePill()
  return null
}

function Composer({
  showControl,
  replyTo,
  quote,
  withPill = false,
}: {
  showControl: boolean
  replyTo?: {uri: string}
  quote?: {uri: string}
  withPill?: boolean
}) {
  usePrivateComposeSession(replyTo, quote)
  return showControl ? (
    <ComposerAudienceProvider
      replyTo={replyTo}
      thread={thread}
      dispatch={() => {}}>
      <ComposerAudienceRow />
      <PillProbe />
      {withPill ? <ComposerAudiencePill /> : null}
      <ComposerAudienceSlot />
    </ComposerAudienceProvider>
  ) : null
}

afterEach(() => {
  setComposeVisibility(PUBLIC_COMPOSE)
  mockAudienceMenu.mockClear()
  pillShown = undefined
  mockDefaults = undefined
})

describe('where the audience drop-down sits (v2 live check 1)', () => {
  it('the footer slot and the phone row hold only the visibility control; the drop-down is the pill', () => {
    const screen = render(<Composer showControl />)
    expect(pillShown).toBe(true)
    expect(mockAudienceMenu).not.toHaveBeenCalled()
    screen.rerender(<Composer showControl withPill />)
    expect(mockAudienceMenu).toHaveBeenCalled()
    expect(mockAudienceMenu.mock.calls.at(-1)?.[0]).toMatchObject({
      visibility: 'public',
      nudge: true,
    })
    screen.unmount()
  })

  it('in Private the same drop-down carries who can see', () => {
    const screen = render(<Composer showControl withPill />)
    act(() => {
      chooseComposeVisibility({
        visibility: 'private',
        audience: {kind: 'mode', mode: 'followers'},
      })
    })
    expect(mockAudienceMenu.mock.calls.at(-1)?.[0]).toMatchObject({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'followers'},
    })
    screen.unmount()
  })

  it('a reply to a public post shows the drop-down only once Private, for who can see alone', () => {
    const screen = render(
      <Composer showControl withPill replyTo={{uri: PUBLIC_PARENT}} />,
    )
    expect(pillShown).toBe(false)
    expect(mockAudienceMenu).not.toHaveBeenCalled()
    act(() => {
      chooseComposeVisibility({visibility: 'private'})
    })
    expect(pillShown).toBe(true)
    const props = mockAudienceMenu.mock.calls.at(-1)?.[0]
    expect(props).toMatchObject({visibility: 'private'})
    expect(props?.threadgate).toBeUndefined()
    expect(props?.postgate).toBeUndefined()
    screen.unmount()
  })

  it('a locked reply in a private thread has no drop-down', () => {
    const screen = render(
      <Composer showControl withPill replyTo={{uri: PRIVATE_PARENT}} />,
    )
    expect(pillShown).toBe(false)
    expect(mockAudienceMenu).not.toHaveBeenCalled()
    screen.unmount()
  })
})

describe('the composer owns the visibility record', () => {
  it('remounting the control leaves the record as it was', () => {
    const screen = render(<Composer showControl />)
    act(() => {
      chooseComposeVisibility({
        visibility: 'private',
        audience: {kind: 'mode', mode: 'followers'},
      })
    })
    const chosen = getComposeVisibility()
    expect(chosen.visibility).toBe('private')

    // The web footer moves into the active post: the control unmounts...
    screen.rerender(<Composer showControl={false} />)
    expect(getComposeVisibility()).toBe(chosen)
    // ...and mounts again.
    screen.rerender(<Composer showControl />)
    expect(getComposeVisibility()).toBe(chosen)

    // Only closing the composer resets it.
    screen.unmount()
    expect(getComposeVisibility()).toEqual(PUBLIC_COMPOSE)
  })

  it('a reply to a private post starts Private and locked, and cannot be made public', () => {
    const screen = render(
      <Composer showControl replyTo={{uri: PRIVATE_PARENT}} />,
    )
    expect(getComposeVisibility()).toMatchObject({
      visibility: 'private',
      locked: true,
      audience: {kind: 'parent'},
    })
    act(() => {
      chooseComposeVisibility({visibility: 'public'})
    })
    expect(getComposeVisibility().visibility).toBe('private')
    screen.unmount()
    expect(getComposeVisibility()).toEqual(PUBLIC_COMPOSE)
  })

  it('a reply to a public post starts Public', () => {
    const screen = render(
      <Composer
        showControl
        replyTo={{uri: `at://${DID}/app.bsky.feed.post/3kpublic22222`}}
      />,
    )
    expect(getComposeVisibility()).toEqual(PUBLIC_COMPOSE)
    screen.unmount()
  })
})

describe('the private posting defaults (Phase 3, batch B)', () => {
  const FOLLOWERS: PrivateDefaults = {
    startAs: 'private',
    audience: {kind: 'mode', mode: 'followers'},
  }
  const LIST = `at://${DID}/tools.kryphocron.policy.audience/3klist1111111`

  it('without defaults (a non-member, or the switches off) a post starts Public with Everyone', () => {
    expect(initialComposeVisibility(undefined, undefined)).toEqual(
      PUBLIC_COMPOSE,
    )
  })

  it('a top-level post starts as the defaults say', () => {
    expect(initialComposeVisibility(undefined, FOLLOWERS)).toEqual({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'followers'},
      locked: false,
    })
    expect(
      initialComposeVisibility(undefined, {
        startAs: 'public',
        audience: {kind: 'list', uri: LIST},
      }),
    ).toEqual({
      visibility: 'public',
      audience: {kind: 'list', uri: LIST},
      locked: false,
    })
  })

  it('a reply to a public post starts Public but holds the default audience', () => {
    expect(initialComposeVisibility(PUBLIC_PARENT, FOLLOWERS)).toEqual({
      visibility: 'public',
      audience: {kind: 'mode', mode: 'followers'},
      locked: false,
    })
  })

  it('a reply to a private post stays locked under its parent, whatever the defaults', () => {
    expect(initialComposeVisibility(PRIVATE_PARENT, FOLLOWERS)).toMatchObject({
      visibility: 'private',
      locked: true,
      audience: {kind: 'parent'},
    })
  })

  it('the composer opens on the defaults, and a post can still change them', () => {
    mockDefaults = FOLLOWERS
    const screen = render(<Composer showControl />)
    expect(getComposeVisibility()).toMatchObject({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'followers'},
    })
    act(() => {
      chooseComposeVisibility({visibility: 'public'})
    })
    expect(getComposeVisibility().visibility).toBe('public')
    screen.unmount()
    expect(getComposeVisibility()).toEqual(PUBLIC_COMPOSE)
  })

  it('defaults that arrive after opening apply until the post is changed', () => {
    const screen = render(<Composer showControl />)
    expect(getComposeVisibility()).toEqual(PUBLIC_COMPOSE)
    mockDefaults = FOLLOWERS
    screen.rerender(<Composer showControl />)
    expect(getComposeVisibility().visibility).toBe('private')

    act(() => {
      chooseComposeVisibility({audience: {kind: 'mode', mode: 'nobody'}})
    })
    // A later answer no longer replaces what was chosen.
    mockDefaults = {...FOLLOWERS, audience: {kind: 'mode', mode: 'everyone'}}
    screen.rerender(<Composer showControl />)
    expect(getComposeVisibility().audience).toEqual({
      kind: 'mode',
      mode: 'nobody',
    })
    screen.unmount()
  })

  it('a draft restored over the defaults is not replaced by them', () => {
    const screen = render(<Composer showControl />)
    act(() => {
      setComposeVisibility(PUBLIC_COMPOSE)
    })
    mockDefaults = FOLLOWERS
    screen.rerender(<Composer showControl />)
    expect(getComposeVisibility()).toEqual(PUBLIC_COMPOSE)
    screen.unmount()
  })
})

describe('quotes start as the quoted post is (round 2 list, item 6)', () => {
  const PRIVATE_QUOTED = PRIVATE_PARENT
  const PUBLIC_QUOTED = PUBLIC_PARENT
  const LIST = `at://${DID}/tools.kryphocron.policy.audience/3klist1111111`
  const STARTS_PUBLIC_TO_LIST: PrivateDefaults = {
    startAs: 'public',
    audience: {kind: 'list', uri: LIST},
  }
  const STARTS_PRIVATE_TO_FOLLOWING: PrivateDefaults = {
    startAs: 'private',
    audience: {kind: 'mode', mode: 'following'},
  }

  it('a quote of a private post starts Private with the default audience, over "New posts start as"', () => {
    expect(
      initialComposeVisibility(
        undefined,
        STARTS_PUBLIC_TO_LIST,
        PRIVATE_QUOTED,
      ),
    ).toEqual({
      visibility: 'private',
      audience: {kind: 'list', uri: LIST},
      locked: false,
    })
  })

  it('with no default audience chosen, a quote of a private post starts Private to Followers', () => {
    expect(
      initialComposeVisibility(undefined, {startAs: 'public'}, PRIVATE_QUOTED),
    ).toEqual({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'followers'},
      locked: false,
    })
    // A post that is not a quote, made Private, still uses Everyone.
    expect(initialComposeVisibility(undefined, {startAs: 'private'})).toEqual({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'everyone'},
      locked: false,
    })
  })

  it('a quote of a public post starts Public, over "New posts start as", holding the default audience', () => {
    expect(
      initialComposeVisibility(
        undefined,
        STARTS_PRIVATE_TO_FOLLOWING,
        PUBLIC_QUOTED,
      ),
    ).toEqual({
      visibility: 'public',
      audience: {kind: 'mode', mode: 'following'},
      locked: false,
    })
    expect(
      initialComposeVisibility(undefined, {startAs: 'private'}, PUBLIC_QUOTED),
    ).toEqual({
      visibility: 'public',
      audience: {kind: 'mode', mode: 'everyone'},
      locked: false,
    })
  })

  it('non-members always start Public, whatever is quoted', () => {
    expect(
      initialComposeVisibility(undefined, undefined, PRIVATE_QUOTED),
    ).toEqual(PUBLIC_COMPOSE)
    expect(
      initialComposeVisibility(undefined, undefined, PUBLIC_QUOTED),
    ).toEqual(PUBLIC_COMPOSE)
  })

  it('replies are unchanged: a reply follows its parent, not its quote', () => {
    expect(
      initialComposeVisibility(
        PRIVATE_PARENT,
        STARTS_PUBLIC_TO_LIST,
        PUBLIC_QUOTED,
      ),
    ).toMatchObject({
      visibility: 'private',
      locked: true,
      audience: {kind: 'parent'},
    })
    expect(
      initialComposeVisibility(
        PUBLIC_PARENT,
        STARTS_PRIVATE_TO_FOLLOWING,
        PRIVATE_QUOTED,
      ),
    ).toEqual({
      visibility: 'public',
      audience: {kind: 'mode', mode: 'following'},
      locked: false,
    })
  })

  it('the composer opens a quote of a private post Private, and it can be made Public', () => {
    mockDefaults = STARTS_PUBLIC_TO_LIST
    const screen = render(
      <Composer showControl quote={{uri: PRIVATE_QUOTED}} />,
    )
    expect(getComposeVisibility()).toEqual({
      visibility: 'private',
      audience: {kind: 'list', uri: LIST},
      locked: false,
    })
    // Not locked: a public quote of a private post is allowed.
    act(() => {
      chooseComposeVisibility({visibility: 'public'})
    })
    expect(getComposeVisibility().visibility).toBe('public')
    screen.unmount()
    expect(getComposeVisibility()).toEqual(PUBLIC_COMPOSE)
  })

  it('the composer opens a quote of a public post Public for a member who starts posts Private', () => {
    mockDefaults = STARTS_PRIVATE_TO_FOLLOWING
    const screen = render(<Composer showControl quote={{uri: PUBLIC_QUOTED}} />)
    expect(getComposeVisibility().visibility).toBe('public')
    screen.unmount()
  })

  it('a quote of a private post opens Public for a non-member', () => {
    mockDefaults = undefined
    const screen = render(
      <Composer showControl quote={{uri: PRIVATE_QUOTED}} />,
    )
    expect(getComposeVisibility()).toEqual(PUBLIC_COMPOSE)
    screen.unmount()
  })

  it('defaults that arrive after opening a quote of a private post make it Private, until changed', () => {
    const screen = render(
      <Composer showControl quote={{uri: PRIVATE_QUOTED}} />,
    )
    expect(getComposeVisibility()).toEqual(PUBLIC_COMPOSE)
    mockDefaults = {startAs: 'public'}
    screen.rerender(<Composer showControl quote={{uri: PRIVATE_QUOTED}} />)
    expect(getComposeVisibility()).toEqual({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'followers'},
      locked: false,
    })
    act(() => {
      chooseComposeVisibility({visibility: 'public'})
    })
    mockDefaults = STARTS_PUBLIC_TO_LIST
    screen.rerender(<Composer showControl quote={{uri: PRIVATE_QUOTED}} />)
    expect(getComposeVisibility().visibility).toBe('public')
    screen.unmount()
  })
})

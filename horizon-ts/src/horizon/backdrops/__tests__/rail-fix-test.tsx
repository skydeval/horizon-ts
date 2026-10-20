/*
 * The rail fix: a rail card sizes to its content (no scroller of its own,
 * no capped height), and a long feeds list renders whole inside its card.
 * The header fix: stock full-width backgrounds take the reading surface's
 * box while a backdrop is drawn.
 */

import {StyleSheet, Text, View} from 'react-native'
import {beforeEach, describe, expect, it, jest} from '@jest/globals'
import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {render, renderHook} from '@testing-library/react-native'

import {DesktopFeeds} from '#/view/shell/desktop/Feeds'
import type * as ThemesModule from '#/alf/themes'
import * as store from '#/horizon/appearance/store'
import {
  cardStockStyle,
  RAIL_SCROLL_STYLE,
  RailCard,
} from '#/horizon/backdrops/RailCard'
import {
  READING_COLUMN_WIDTH,
  readingColumnBox,
  useReadingColumnBox,
} from '#/horizon/backdrops/surface-box'

let mockGtMobile = true
jest.mock('#/alf', () => ({
  atoms: new Proxy(
    {
      flex_1: {flex: 1},
      scrollbar_offset: {transform: []},
    },
    {
      get: (target: Record<string, object>, key: string) => target[key] ?? {},
    },
  ),
  useTheme: () =>
    jest.requireActual<typeof ThemesModule>('#/alf/themes').themes.light,
  useBreakpoints: () => ({gtMobile: mockGtMobile}),
  useLayoutBreakpoints: () => ({centerColumnOffset: false}),
  web: (value: unknown) => value,
}))
jest.mock('#/env', () => ({
  ...jest.requireActual<Record<string, unknown>>('#/env'),
  IS_WEB: true,
}))
jest.mock('#/state/session', () => ({
  useSession: () => ({currentAccount: undefined}),
}))
jest.mock('#/horizon/appearance/device-store', () => ({
  readDeviceJson: () => undefined,
  writeDeviceJson: () => {},
  subscribeDeviceJson: () => () => {},
}))
jest.mock('#/horizon/backdrops/BackdropWindow', () =>
  jest.requireActual('#/horizon/backdrops/BackdropWindow.web'),
)
jest.mock('#/horizon/backdrops/viewport', () => ({
  useViewportFrame: () => ({width: 1440, height: 900}),
}))
jest.mock('#/screens/Messages/components/splitView/context', () => ({
  useIsWithinSplitView: () => ({isWithinSplitView: false}),
}))

/** A real account's long pinned list (the bug showed with about 17). */
const FEED_COUNT = 24
const mockFeeds = Array.from({length: FEED_COUNT}, (_, i) => ({
  uri: `at://did:plc:feed/app.bsky.feed.generator/f${i}`,
  feedDescriptor: i === 0 ? 'following' : `feedgen|f${i}`,
  displayName: `Feed number ${i} with a fairly long display name`,
  type: 'feed',
  avatar: undefined,
}))
jest.mock('#/state/queries/feed', () => ({
  usePinnedFeedsInfos: () => ({
    data: mockFeeds,
    error: null,
    isLoading: false,
  }),
}))
jest.mock('#/state/shell/selected-feed', () => ({
  useSelectedFeed: () => undefined,
  useSetSelectedFeed: () => () => {},
}))
jest.mock('#/lib/strings/feed-names', () => ({
  getLocalizedFeedName: (feed: {displayName: string}) => feed.displayName,
}))
jest.mock('#/analytics', () => ({
  useAnalytics: () => ({metric: () => {}}),
}))
jest.mock('#/view/com/util/UserAvatar', () => ({
  UserAvatar: () => null,
}))
jest.mock('#/components/Link', () => {
  const {View: MockView} =
    jest.requireActual<typeof import('react-native')>('react-native')
  return {
    Link: ({
      children,
      style,
    }: {
      children: (state: {hovered: boolean}) => React.ReactNode
      style?: object
    }) => <MockView style={style}>{children({hovered: false})}</MockView>,
  }
})
jest.mock('#/components/Typography', () => {
  const {Text: MockText} =
    jest.requireActual<typeof import('react-native')>('react-native')
  return {Text: MockText}
})
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual<Record<string, unknown>>('@react-navigation/native'),
  useNavigation: () => ({navigate: () => {}}),
  useNavigationState: () => ({name: 'Home'}),
}))

i18n.loadAndActivate({locale: 'en', messages: {}})

/** Keys that make a box scroll or cap its height. */
function scrollsOrCaps(style: Record<string, unknown>): string[] {
  const found: string[] = []
  for (const key of ['overflow', 'overflowX', 'overflowY']) {
    if (style[key] === 'auto' || style[key] === 'scroll') found.push(key)
  }
  for (const key of ['height', 'maxHeight', 'flex', 'flexGrow', 'flexBasis']) {
    if (style[key] !== undefined) found.push(key)
  }
  return found
}

beforeEach(() => {
  mockGtMobile = true
  store.resetAppearanceStoreForTests()
})

describe('rail cards size to their content (rail fix)', () => {
  it('drops a stock style scroller and cap, keeps the rest', () => {
    expect(
      cardStockStyle([
        {flex: 1},
        {
          gap: 2,
          paddingTop: 2,
          overflowY: 'auto',
          maxHeight: 400,
          height: 300,
        } as object,
      ]),
    ).toEqual({gap: 2, paddingTop: 2})
    expect(cardStockStyle(undefined)).toEqual({})
  })

  it('the active card over the feeds list style neither scrolls nor caps', () => {
    store.selectBackdrop(undefined, 'pride.trans')
    const {UNSAFE_getAllByType} = render(
      <RailCard style={[{flex: 1}, {gap: 2, overflowY: 'auto'} as object]}>
        <Text>child</Text>
      </RailCard>,
    )
    const card = StyleSheet.flatten(
      UNSAFE_getAllByType(View)[0].props.style,
    ) as Record<string, unknown>
    expect(scrollsOrCaps(card)).toEqual([])
    expect(card.gap).toBe(2)
  })

  it('inactive keeps the stock scroller (stock unchanged)', () => {
    const {UNSAFE_getAllByType} = render(
      <RailCard style={[{flex: 1}, {overflowY: 'auto'} as object]}>
        <Text>child</Text>
      </RailCard>,
    )
    const stock = StyleSheet.flatten(
      UNSAFE_getAllByType(View)[0].props.style,
    ) as Record<string, unknown>
    expect(stock).toEqual({flex: 1, overflowY: 'auto'})
  })

  it('a long feeds list renders whole, in a card that neither scrolls nor caps', () => {
    store.selectBackdrop(undefined, 'pride.trans')
    const screen = render(
      <I18nProvider i18n={i18n}>
        <DesktopFeeds />
      </I18nProvider>,
    )
    for (const feed of mockFeeds) {
      expect(screen.getByText(feed.displayName)).toBeTruthy()
    }
    expect(screen.getByText('More feeds')).toBeTruthy()
    const views = screen.UNSAFE_getAllByType(View)
    const flat = (view: (typeof views)[number]) =>
      StyleSheet.flatten(view.props.style ?? {}) as Record<string, unknown>
    // The card: no scroller, no capped height, no flex sizing.
    expect(scrollsOrCaps(flat(views[0]))).toEqual([])
    // Nothing under it scrolls either (the icons keep their fixed size).
    for (const view of views) {
      const style = flat(view)
      expect([style.overflow, style.overflowX, style.overflowY]).not.toContain(
        'auto',
      )
      expect([style.overflow, style.overflowX, style.overflowY]).not.toContain(
        'scroll',
      )
    }
    // The painter is the only clip, and it is out of the flow.
    const json = screen.toJSON() as unknown as {
      children: {type: string; props: {style: Record<string, unknown>}}[]
    }
    const paint = json.children[0]
    expect(paint.type).toBe('div')
    expect(paint.props.style).toMatchObject({
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      overflow: 'hidden',
    })
  })

  it('the rail itself scrolls, vertically only, with no scrollbar to narrow the cards', () => {
    expect(RAIL_SCROLL_STYLE).toEqual({
      overflowX: 'hidden',
      overflowY: 'auto',
      scrollbarWidth: 'none',
    })
  })
})

describe('stock full-width backgrounds stay on the reading surface (header fix)', () => {
  it('desktop: the centre column; phone: the inset card or the full width', () => {
    expect(
      readingColumnBox({
        gtMobile: true,
        inset: false,
        centerColumnOffset: false,
      }),
    ).toMatchObject({left: '50%', right: 'auto', width: READING_COLUMN_WIDTH})
    expect(
      readingColumnBox({
        gtMobile: false,
        inset: true,
        centerColumnOffset: false,
      }),
    ).toEqual({
      left: 8,
      right: 8,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
    })
    expect(
      readingColumnBox({
        gtMobile: false,
        inset: false,
        centerColumnOffset: false,
      }),
    ).toBeNull()
  })

  it('no backdrop: stock, the full width', () => {
    const stock = renderHook(() => useReadingColumnBox())
    expect(stock.result.current).toBeNull()
    stock.unmount()
    store.selectBackdrop(undefined, 'pride.trans')
    expect(
      renderHook(() => useReadingColumnBox()).result.current,
    ).toMatchObject({width: READING_COLUMN_WIDTH})
  })
})

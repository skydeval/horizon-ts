import {describe, expect, it, jest} from '@jest/globals'

/*
 * The mocks the fork's own `postFeed.test.tsx` uses to load `postFeed.ts`
 * without the app's providers and native modules.
 */
jest.mock('#/state/preferences/languages', () => ({
  getAppLanguageAsContentLanguage: () => '',
  getContentLanguages: () => [],
}))
jest.mock('#/state/preferences/feed-tuners', () => ({
  useFeedTuners: () => [],
}))
jest.mock('#/state/preferences/moderation-opts', () => ({
  useModerationOpts: () => undefined,
}))
jest.mock('#/state/queries/preferences', () => ({
  usePreferencesQuery: () => ({data: undefined}),
}))
jest.mock('#/state/session', () => ({
  useAppviewClient: () => ({}),
  useSession: () => ({hasSession: false, currentAccount: undefined}),
}))
jest.mock('#/view/com/posts/PostFeedErrorMessage', () => ({
  KnownError: {FeedSignedInOnly: 'FeedSignedInOnly'},
}))
jest.mock('react-native-reanimated', () => ({
  useSharedValue: (initial: unknown) => ({get: () => initial, set: () => {}}),
}))
jest.mock('react-native-worklets', () => ({
  scheduleOnRN: (fn: (...args: unknown[]) => void, ...args: unknown[]) =>
    fn(...args),
}))

import {RQKEY as LEGACY_RQKEY} from '#/state/queries/post-feed'
import {FOLLOWING_SNAPSHOT_QUERY_KEY} from '#/features/followingV2/home/queries/followingSnapshot'
import {RQKEY} from '#/features/followingV2/home/queries/postFeed'

describe('the Following query key with no member', () => {
  it('still equals the native snapshot’s spelled-out key', () => {
    expect(RQKEY('following')).toEqual(FOLLOWING_SNAPSHOT_QUERY_KEY)
  })

  it('leaves the legacy key stock', () => {
    expect(LEGACY_RQKEY('following')).toEqual(['post-feed', 'following', {}])
  })
})

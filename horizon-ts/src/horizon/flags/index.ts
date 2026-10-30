import {type FeatureApiResponse} from '@growthbook/growthbook'

import {Features} from '#/analytics/features/types'

/**
 * When the defaults below were read from Bluesky's public feature payload, and
 * that payload's own `dateUpdated`.
 */
export const FLAGS_READ_AT = '2026-10-14'
export const FLAGS_SOURCE_DATE_UPDATED = '2026-10-13T13:41:07.428Z'

/**
 * Horizon's local feature-flag table: one entry for every key in Bluesky's
 * `Features` enum, set to the public default (no rollout rules), except that
 * the features Bluesky offers as betas are on by default in Horizon. Reviewed
 * at each upstream merge: new enum keys get an entry, a key whose public
 * default flipped is considered, and new Bluesky betas are considered for
 * turning on.
 */
const DEFAULTS: Record<Features, unknown> = {
  [Features.IsBskyTeam]: false,
  [Features.DebugFeedContext]: false,
  [Features.ImportContactsOnboardingDisable]: false,
  [Features.ImportContactsSettingsDisable]: false,
  [Features.LiveNowBetaDisable]: false,
  [Features.GroupChatsDisable]: false,
  [Features.ComposerLanguageDetectionEnable]: false,
  [Features.PostGalleryEmbedEnable]: false,
  /*
   * Bluesky beta "Social proofing on posts" (the "Liked by ..." row under a
   * post): off in Horizon since 2026-10-25 (skydeval, on trial), so posts
   * show the like count only. Set both to true to bring the row back.
   */
  [Features.PostFeedKnownLikersEnable]: false,
  // The same row on the thread's main post
  [Features.PostThreadKnownLikersEnable]: false,
  [Features.FollowSortEnable]: false,
  // Bluesky beta, on in Horizon: "Keep your place in the Following feed" (native only)
  [Features.FollowingV2Enable]: true,
  [Features.OnboardingInterestsRequiredEnable]: false,
  // Bluesky's moderation inbox, released 2026-10-30: on in Horizon (skydeval)
  [Features.ModerationInboxEnable]: true,
  // Renamed from atmosphere_explore:enable upstream; public default false (read 2026-10-24)
  [Features.AtmosphereScreenEnable]: false,
  // Bluesky beta, on in Horizon: "Redesigned notifications"
  [Features.NotificationsV2Enable]: true,
  /*
   * Profile links lost their flag upstream (2026-10-30 merge) and are always
   * on; the link editor's payment guard still applies, see
   * src/horizon/profile-links/payment-domains.ts.
   */
  [Features.StarterPacksConfig]: {limit: 150},
  [Features.TrendingDiscoverValues]: {topics: 5, accounts: 15, videos: 30},
  [Features.TrendingExploreTopicsCountValue]: 5,
  [Features.AATest]: false,
}

/**
 * The table as a GrowthBook payload, which Bluesky's feature client loads
 * synchronously with no network request.
 */
export const localFeaturePayload: FeatureApiResponse = {
  dateUpdated: FLAGS_SOURCE_DATE_UPDATED,
  features: Object.fromEntries(
    Object.entries(DEFAULTS).map(([key, defaultValue]) => [
      key,
      {defaultValue},
    ]),
  ),
  savedGroups: {},
  experiments: [],
}

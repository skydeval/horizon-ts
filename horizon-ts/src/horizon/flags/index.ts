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
  // Bluesky beta, on in Horizon: "Social proofing on posts"
  [Features.PostFeedKnownLikersEnable]: true,
  // The same social proofing on the thread's main post
  [Features.PostThreadKnownLikersEnable]: true,
  [Features.FollowSortEnable]: false,
  // Bluesky beta, on in Horizon: "Keep your place in the Following feed" (native only)
  [Features.FollowingV2Enable]: true,
  [Features.OnboardingInterestsRequiredEnable]: false,
  [Features.ModerationInboxEnable]: false,
  // Renamed from atmosphere_explore:enable upstream; public default false (read 2026-10-24)
  [Features.AtmosphereScreenEnable]: false,
  // Bluesky beta, on in Horizon: "Redesigned notifications"
  [Features.NotificationsV2Enable]: true,
  /*
   * Profile links: Bluesky's public default is true (read 2026-10-24). On in
   * Horizon since the link editor's payment guard landed (2026-10-24): a link
   * on a payment or support host is never sent to cardyb (no title, favicon
   * or reachability check), and typing is debounced. See
   * src/horizon/profile-links/payment-domains.ts and
   * docs/internal/notes/upstream-profile-links-audit.md.
   */
  [Features.ProfileLinksEnable]: true,
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

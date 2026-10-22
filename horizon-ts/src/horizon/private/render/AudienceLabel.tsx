/*
 * The audience of a private post, shown by name (7.2). prism's governing
 * audience (P-3: the thread root's current audience, the branch root's in a
 * branch, the post's own when top-level) comes first, then the one the
 * record names (2H design 5.6), except while this client has just moved the
 * post (the facts' pin). The current account's own audiences come from its
 * audience list; another account's audience is labelled from what prism
 * serves when that names it, else read from that account's PDS (a plain
 * record; skydeval's ruling of 2026-10-15).
 */

import {View} from 'react-native'
import {AtUri} from '@atproto/syntax'
import {useLingui} from '@lingui/react/macro'
import {useQuery} from '@tanstack/react-query'

import {createLexClient} from '#/lib/lexClient'
import {STALE} from '#/state/queries'
import {resolvePdsForIdentifier} from '#/state/queries/pds-detection'
import {useProfileQuery} from '#/state/queries/profile'
import {useSession} from '#/state/session'
import {networkAwareFetch} from '#/state/session/network'
import {atoms as a, useTheme} from '#/alf'
import {Text} from '#/components/Typography'
import {
  type AudienceEntry,
  labelsFromServedAudience,
  postAudienceLabel,
  readAudienceRecordAt,
} from '#/horizon/private/api/audiences'
import {useAudiencesQuery} from '#/horizon/private/audiences/useAudiencesQuery'
import {isPrivateDisplay} from '#/horizon/private/render/controls'
import {PrivateMark} from '#/horizon/private/render/PrivateBadge'
import {usePrivatePostFacts} from '#/horizon/private/store'
import {isAudienceUri} from '#/horizon/private/uri'

function ownerOf(audienceUri: string | undefined): string | undefined {
  if (!audienceUri || !isAudienceUri(audienceUri)) return undefined
  return new AtUri(audienceUri).host
}

/**
 * Another account's audience record, read without a session from the PDS
 * its owner's DID document names.
 */
function useAudienceRecord(uri: string | undefined, enabled: boolean) {
  return useQuery<AudienceEntry | null>({
    queryKey: ['horizon-audience-record', uri],
    staleTime: STALE.HOURS.ONE,
    enabled: enabled && !!uri,
    queryFn: async () => {
      const owner = ownerOf(uri)
      if (!uri || !owner) return null
      const identity = await resolvePdsForIdentifier(owner)
      if (!identity?.pdsUrl) return null
      const client = createLexClient(
        {service: identity.pdsUrl, fetch: networkAwareFetch},
        {appLabelers: null},
      )
      return (await readAudienceRecordAt(client, uri)) ?? null
    },
  })
}

/**
 * The label of the audience a private post names (`postAudienceLabel`), or
 * `undefined` while loading, after a failed read, or for a post that is not
 * private. The served audience comes first, then the record's, then
 * `audienceUri` (a composer reply whose parent's facts are not in the
 * store). While the facts hold a pin, the store keeps no served audience,
 * so the pinned one is used.
 */
export function usePostAudienceLabel(
  postUri: string | undefined,
  audienceUriOverride?: string,
): string | undefined {
  const {currentAccount} = useSession()
  const facts = usePrivatePostFacts(postUri)
  const served = facts?.servedAudience
  const audienceUri = served?.uri ?? facts?.audienceUri ?? audienceUriOverride
  const known = !!facts || !!audienceUriOverride
  const owner = ownerOf(audienceUri)
  const isOwn = !!owner && owner === currentAccount?.did
  const isOther = !!owner && !isOwn
  const {data: ownAudiences} = useAudiencesQuery({enabled: known && isOwn})
  // The PDS record only where the served audience does not name it.
  const {data: record} = useAudienceRecord(
    audienceUri,
    known && isOther && !labelsFromServedAudience(served),
  )
  const {data: ownerProfile} = useProfileQuery({
    did: known && isOther ? owner : undefined,
    staleTime: STALE.HOURS.ONE,
  })
  if (!known) return undefined
  return postAudienceLabel({
    audienceUri,
    currentDid: currentAccount?.did,
    ownAudiences,
    record: record ?? undefined,
    ownerHandle: ownerProfile?.handle,
    served,
  })
}

/**
 * The thread anchor's private details (Mark 8), after the date: the badge
 * and its audience, "Private · <label>". While the label loads, the badge
 * alone, with no dot. Nothing for a post that is not private.
 */
export function PrivatePostDetails({post}: {post: {uri: string}}) {
  if (!isPrivateDisplay(post.uri)) return null
  return <PrivatePostDetailsInner uri={post.uri} />
}

function PrivatePostDetailsInner({uri}: {uri: string}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const label = usePostAudienceLabel(uri)
  return (
    <View style={[a.flex_row, a.align_center, a.flex_wrap, a.gap_xs]}>
      <PrivateMark size="sm" />
      {label ? (
        <>
          {/* The row's gap spaces the dot like a space each side, as in the date */}
          <Text
            accessible={false}
            aria-hidden
            importantForAccessibility="no"
            style={[a.text_sm, t.atoms.text_contrast_medium]}>
            &middot;
          </Text>
          <Text
            testID="privatePostAudience"
            accessibilityLabel={l`Shared with ${label}`}
            accessibilityHint={l`The audience who can see this post`}
            style={[a.text_sm, t.atoms.text_contrast_medium]}>
            {label}
          </Text>
        </>
      ) : null}
    </View>
  )
}

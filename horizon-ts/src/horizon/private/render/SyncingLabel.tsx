import {Trans, useLingui} from '@lingui/react/macro'

import {atoms as a, useTheme, web} from '#/alf'
import {Text} from '#/components/Typography'
import {isOwnPrivateUri, useIsSyncing} from '#/horizon/private/known'
import {useSlotFloor} from '#/horizon/private/load-gate'
import {isPrivateBadgeHref} from '#/horizon/private/render/controls'
import {PP_COLLECTION} from '#/horizon/private/uri'
import {useCurrentClients} from '#/horizon/routing/current-clients'

/**
 * "Syncing" beside the timestamp of the reader's own private post (prism busy
 * design 6.2, decision 2): shown exactly while `useIsSyncing(uri,
 * useSlotFloor(uri))` holds. Contrast-medium text, no icon. Nothing for
 * another author's post or a public one.
 */
export function SyncingLabel({
  uri,
  size = 'md',
}: {
  uri: string
  /** `md` in a post's meta row, `sm` in the thread anchor's date row. */
  size?: 'sm' | 'md'
}) {
  const did = useCurrentClients()?.did
  if (!did || !isOwnPrivateUri(uri, did)) return null
  return <SyncingLabelInner uri={uri} size={size} />
}

function SyncingLabelInner({uri, size}: {uri: string; size: 'sm' | 'md'}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const floor = useSlotFloor(uri)
  const syncing = useIsSyncing(uri, floor)
  if (!syncing) return null
  return (
    <Text
      testID="privatePostSyncing"
      accessibilityLabel={l`Syncing`}
      accessibilityHint={l`Your private post is saved; it shows to its audience once it syncs`}
      style={[
        size === 'md' ? a.text_md : a.text_sm,
        a.leading_tight,
        a.pl_xs,
        a.flex_shrink_0,
        t.atoms.text_contrast_medium,
        web({whiteSpace: 'nowrap'}),
      ]}>
      <Trans>Syncing</Trans>
    </Text>
  )
}

/**
 * {@link SyncingLabel} for a post meta row, which knows the post by its link:
 * a `ppost` path of `authorDid`'s post.
 */
export function SyncingMetaLabel({
  authorDid,
  postHref,
}: {
  authorDid: string
  postHref: string
}) {
  if (!isPrivateBadgeHref(postHref)) return null
  const rkey = postHref.split('/').filter(Boolean).pop()
  if (!rkey) return null
  return <SyncingLabel uri={`at://${authorDid}/${PP_COLLECTION}/${rkey}`} />
}

/*
 * The composer note (Phase 4 design 8.5, TL-19; hook TH-10): one quiet line
 * under the reply-to preview when the post being replied to has a
 * `blocking-you` gap somewhere above it in a lens snapshot of this query
 * client (so of this account). That author will not see the reply.
 *
 * The snapshot used is the most recently updated one holding the URI (the
 * screen the reader replied from, in every ordinary case), and the walk
 * follows `parentUri` up through its map. Never for a `blocked-by-you` gap
 * (the reader chose that block) or any other kind, and it makes no call.
 *
 * It reads the query cache through `useSyncExternalStore` with a boolean
 * snapshot (TL-34), so a refetch that drops the gap hides the note with the
 * composer open. The cache's events are many; only those whose key's root is
 * the lens root are passed on, and the walk is kept per snapshot object and
 * URI, so it runs once per lens write (v6: R4-N8).
 */

import {useSyncExternalStore} from 'react'
import {useLingui} from '@lingui/react/macro'
import {type QueryCacheNotifyEvent, useQueryClient} from '@tanstack/react-query'

import {atoms as a, useTheme} from '#/alf'
import {Text} from '#/components/Typography'
import {THREAD_LENS} from '#/horizon/switches'
import {lensReplyNoteHolds} from '#/horizon/thread-lens/reply-note'
import {LENS_ROOT} from '#/horizon/thread-lens/snapshot'
import {REPLY_NOTE} from '#/horizon/thread-lens/strings'

/** Whether the composer note shows for a reply to `uri`, kept current. */
export function useThreadLensReplyNote(uri: string | undefined): boolean {
  const qc = useQueryClient()
  return useSyncExternalStore(
    callback =>
      qc.getQueryCache().subscribe((event: QueryCacheNotifyEvent) => {
        const key: readonly unknown[] = event.query.queryKey
        if (key[0] === LENS_ROOT) callback()
      }),
    () => THREAD_LENS && !!uri && lensReplyNoteHolds(qc, uri),
  )
}

/** The composer note under the reply-to preview (TH-10), or nothing. */
export function ThreadLensReplyNote({replyTo}: {replyTo?: {uri: string}}) {
  const t = useTheme()
  const {i18n} = useLingui()
  const shows = useThreadLensReplyNote(replyTo?.uri)
  if (!shows) return null
  return (
    <Text
      style={[
        a.mx_lg,
        a.mb_md,
        a.text_sm,
        a.leading_snug,
        t.atoms.text_contrast_medium,
      ]}>
      {i18n._(REPLY_NOTE)}
    </Text>
  )
}

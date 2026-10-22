/*
 * Edit from Unsent (2K design PA-28, Edit; hooks Comp 4 and Comp 5): the
 * composer that mounts after `stageOutboxEdit` restores the entry, from the
 * capture this tab holds (with its images and videos, through object URLs
 * the outbox made) or from the record alone (no media, with the note).
 *
 * The composer is restored through the stock `restore_from_draft` with no
 * draft id and no local refs, so a draft saved from it copies its own media
 * under its own keys. Pressing Post there makes a new compose with new
 * rkeys, which replaces the old entry at its press (`pressEncodeCompose`).
 */

import {useLayoutEffect} from 'react'

import {threadgateAllowUISettingToAllowRecordValue} from '#/state/queries/threadgate/util'
import {type RestoredVideo} from '#/view/com/composer/drafts/state/api'
import {type ComposerAction} from '#/view/com/composer/state/composer'
import * as Toast from '#/components/Toast'
import {replaceComposeSpoilers} from '#/horizon/media-spoilers/compose-store'
import {draftSpoilerSnapshot} from '#/horizon/media-spoilers/drafts'
import {setComposeVisibility} from '#/horizon/private/composer/state'
import {
  clearComposerEdit,
  editRestoreFor,
  revokeEditUrls,
  takeStagedOutboxEdit,
} from '#/horizon/private/outbox'
import {recordHasMedia, recordHasMediaFlags} from './record'
import {mediaDroppedText} from './texts'

export {stageOutboxEdit} from '#/horizon/private/outbox'

type ComposerDispatch = (action: ComposerAction) => void

/**
 * Hook Comp 4: on mount, restore a staged Unsent entry into the composer. A
 * layout effect declared after the composer's visibility and spoiler
 * sessions, so the restored visibility (with its audience) and spoilers are
 * set after the sessions' own start. The outbox's Edit URLs are revoked and
 * the staged id is cleared when the composer unmounts.
 */
export function useOutboxEdit(
  composerDispatch: ComposerDispatch,
  restoreVideo: (postId: string, video: RestoredVideo) => Promise<void>,
) {
  useLayoutEffect(() => {
    const id = takeStagedOutboxEdit()
    if (!id) return
    const restore = editRestoreFor(id)
    if (!restore) {
      clearComposerEdit()
      return
    }
    const {record, posts, videos, urls, withMedia} = restore
    composerDispatch({
      type: 'restore_from_draft',
      draftId: undefined,
      posts,
      threadgateAllow: threadgateAllowUISettingToAllowRecordValue(
        record.gates.threadgate,
      ),
      postgateEmbeddingRules: record.gates.postgate.embeddingRules,
      loadedMedia: new Map(),
      originalLocalRefs: new Set(),
    })
    setComposeVisibility({
      visibility: record.visibility,
      audience: record.audience,
      locked: record.locked,
    })
    replaceComposeSpoilers(
      draftSpoilerSnapshot(
        {id, posts: record.posts.map(post => post.spoilers)},
        posts,
      ),
    )
    for (const video of videos) {
      const postId = posts[video.postIndex]?.id
      if (!postId) continue
      void (async () => {
        const captions = await Promise.all(
          video.captions.map(async (file, index) => ({
            lang: video.captionLangs[index] ?? '',
            content: await file.text(),
          })),
        )
        await restoreVideo(postId, {
          uri: video.uri,
          altText: video.altText,
          mimeType: video.mimeType,
          localRefPath: '',
          captions,
        })
      })()
    }
    if (!withMedia && recordHasMedia(record)) {
      Toast.show(mediaDroppedText(recordHasMediaFlags(record)), {
        type: 'info',
      })
    }
    return () => {
      revokeEditUrls(urls)
      clearComposerEdit()
    }
    // Once, on mount: a staged entry belongs to the composer that opens next.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

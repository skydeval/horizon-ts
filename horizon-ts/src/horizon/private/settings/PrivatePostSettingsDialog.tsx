/*
 * The private post settings dialog (7.8): the author reopens who can see,
 * who can reply and who can quote, with the composer's drop-down.
 *
 * - Who can see changes in place (7.8.1, `updatePostPrivate`, aurora A-9) on
 *   a top-level private post and on a branch root (A-13), while
 *   `PRIVATE_AUDIENCE_CHANGE` is on and the account's posting route offers
 *   it (2K design 8.1: `locus`, and `encode` from 2K-8; never `checking` or
 *   `none`). Any other reply's audience is its
 *   conversation's and is shown read-only. The post's record is read from the
 *   author's own PDS when the dialog opens: its CID is the swap, so a change
 *   made elsewhere since is refused rather than overwritten.
 * - Who can reply is the thread root's threadgate, read from the root
 *   author's PDS (the root may be in another account's repo); only the
 *   root's author can change it, as stock.
 * - Who can quote is the post's own postgate.
 */

import {useState} from 'react'
import {View} from 'react-native'
import {AtUri} from '@atproto/syntax'
import {Trans, useLingui} from '@lingui/react/macro'
import {useQuery, useQueryClient} from '@tanstack/react-query'
import deepEqual from 'fast-deep-equal'

import {logger} from '#/logger'
import {STALE} from '#/state/queries'
import {RQKEY as postQueryKey} from '#/state/queries/post'
import {
  createPostgateQueryKey,
  usePostgateQuery,
} from '#/state/queries/postgate'
import {createPostgateRecord} from '#/state/queries/postgate/util'
import {
  type ThreadgateAllowUISetting,
  threadgateRecordQueryKeyRoot,
  threadgateRecordToAllowUISetting,
} from '#/state/queries/threadgate'
import {postThreadQueryKeyRoot} from '#/state/queries/usePostThread/types'
import {usePdsClient, useSession} from '#/state/session'
import {atoms as a, useTheme, web} from '#/alf'
import {Button, ButtonIcon, ButtonText} from '#/components/Button'
import * as Dialog from '#/components/Dialog'
import {Loader} from '#/components/Loader'
import * as Toast from '#/components/Toast'
import {Text} from '#/components/Typography'
import {
  privateGatesQueryKey,
  readRootThreadgate,
} from '#/horizon/private/api/gates'
import {
  audienceChangeOffered,
  canChangePostAudience,
  changePrivatePostAudience,
  PrivatePostChangedError,
  readOwnPostForSettings,
} from '#/horizon/private/api/update-audience'
import {invalidateAuthorPrivateFeeds} from '#/horizon/private/api/writes'
import {useAudiencesQuery} from '#/horizon/private/audiences/useAudiencesQuery'
import {AudienceMenu} from '#/horizon/private/composer/AudienceMenu'
import {
  quotesAllowed,
  replySummary,
} from '#/horizon/private/composer/interaction'
import {type ComposeAudience} from '#/horizon/private/composer/state'
import {usePrismFeature} from '#/horizon/private/features-hooks'
import {usePostAudienceLabel} from '#/horizon/private/render/AudienceLabel'
import {PRIVATE_AUDIENCE_CHANGE} from '#/horizon/private/server-support'
import {
  moveWarning,
  postSettingsAudience,
  postSettingsChanges,
} from '#/horizon/private/settings/post-settings'
import {
  PrivateGateConflictError,
  PrivatePostPendingError,
  savePrivatePostGates,
} from '#/horizon/private/settings/save-gates'
import {usePrivatePostFacts} from '#/horizon/private/store'
import {usePrismClient} from '#/horizon/routing/prism'
import {useWriteRoute} from '#/horizon/routing/write-route'

/**
 * After an audience change prism has not caught up with, the dialog's
 * invalidations run once more after this delay (2H design 5.7).
 */
const RECHECK_AFTER_MOVE_MS = 5_000

/** One pending second invalidation per post. */
const moveRechecks = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleMoveRecheck(postUri: string, run: () => void) {
  const previous = moveRechecks.get(postUri)
  if (previous !== undefined) clearTimeout(previous)
  moveRechecks.set(
    postUri,
    setTimeout(() => {
      moveRechecks.delete(postUri)
      run()
    }, RECHECK_AFTER_MOVE_MS),
  )
}

export type PrivatePostSettingsDialogProps = {
  control: Dialog.DialogControlProps
  /** The private post, the current account's. */
  postUri: string
  /** The root of its thread, whose threadgate governs replies. */
  rootPostUri: string
  /** The post's record CID as its view has it (the swap if the PDS read fails). */
  postCid?: string
  /** The post's `reply.parent` as its view has it. */
  parentUri?: string
}

/**
 * Menu 9's dialog for a private post, in place of the stock interaction
 * settings dialog.
 */
export function PrivatePostSettingsDialog(
  props: PrivatePostSettingsDialogProps,
) {
  return (
    <Dialog.Outer
      control={props.control}
      nativeOptions={{preventExpansion: true}}>
      <Dialog.Handle />
      <PrivatePostSettingsInner {...props} />
    </Dialog.Outer>
  )
}

function PrivatePostSettingsInner({
  control,
  postUri,
  rootPostUri,
  postCid,
  parentUri,
}: PrivatePostSettingsDialogProps) {
  const t = useTheme()
  const {t: l} = useLingui()
  const {currentAccount} = useSession()
  const pdsClient = usePdsClient()
  const prismClient = usePrismClient()
  const queryClient = useQueryClient()
  const {postingRoute} = useWriteRoute()
  const facts = usePrivatePostFacts(postUri)
  const isReply = rootPostUri !== postUri
  const ownsRoot =
    !!currentAccount && new AtUri(rootPostUri).host === currentAccount.did

  /*
   * Read fresh on every opening (no cache kept), so the swap is the record
   * as it is now.
   */
  const ownRecord = useQuery({
    queryKey: ['horizon-private-own-record', postUri],
    staleTime: 0,
    gcTime: 0,
    retry: 1,
    queryFn: async () =>
      (await readOwnPostForSettings(pdsClient, postUri)) ?? null,
  })
  const stored = ownRecord.data ?? undefined
  /** The post names its own audience: top-level, or a branch root. */
  const ownAudience = canChangePostAudience({
    isReply: stored ? stored.fields.isReply : isReply,
    parentUri: stored ? stored.fields.parent?.uri : parentUri,
  })
  const canChangeAudience =
    PRIVATE_AUDIENCE_CHANGE &&
    ownAudience &&
    audienceChangeOffered(postingRoute)
  const threadAudience = usePrismFeature('private.threadAudience')
  const warning = moveWarning({
    isReply: stored ? stored.fields.isReply : isReply,
    threadAudienceServed: threadAudience,
  })

  const {data: audiences, isLoading: isLoadingAudiences} = useAudiencesQuery({
    enabled: ownAudience,
  })
  const {data: storedPostgate, isLoading: isLoadingPostgate} = usePostgateQuery(
    {postUri},
  )
  const rootThreadgate = useQuery({
    queryKey: [...privateGatesQueryKey(rootPostUri), 'root-threadgate'],
    staleTime: STALE.SECONDS.THIRTY,
    retry: 1,
    queryFn: async () => (await readRootThreadgate(rootPostUri)) ?? null,
  })
  const audienceLabel = usePostAudienceLabel(postUri)

  const [editedThreadgate, setEditedThreadgate] =
    useState<ThreadgateAllowUISetting[]>()
  const [editedPostgate, setEditedPostgate] =
    useState<NonNullable<typeof storedPostgate>>()
  const [editedAudience, setEditedAudience] = useState<ComposeAudience>()
  const [isSaving, setIsSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  // The outbox still holds the post's compose (2K design K10-L3).
  const [pendingText, setPendingText] = useState<string | undefined>()

  const isLoading =
    isLoadingPostgate ||
    rootThreadgate.isLoading ||
    ownRecord.isLoading ||
    (ownAudience && isLoadingAudiences)

  /*
   * A gate whose `post` is not the URI it governs belongs to another post at
   * the same rkey and counts as none (4.14).
   */
  const loadedPostgate =
    storedPostgate && storedPostgate.post === postUri
      ? storedPostgate
      : createPostgateRecord({post: postUri})
  const threadgateFailed = rootThreadgate.isError
  const loadedThreadgate = threadgateRecordToAllowUISetting(
    rootThreadgate.data ?? undefined,
  )
  const threadgateValue = editedThreadgate ?? loadedThreadgate
  const postgateValue = editedPostgate ?? loadedPostgate
  const changes = postSettingsChanges({
    loadedThreadgate,
    editedThreadgate:
      threadgateFailed || !ownsRoot ? undefined : editedThreadgate,
    loadedPostgate,
    editedPostgate,
  })

  const loadedAudience = postSettingsAudience({
    audienceUri: stored?.fields.audienceList ?? facts?.audienceUri,
    isReply: !ownAudience,
    audiences,
  })
  const audienceValue = editedAudience ?? loadedAudience
  const audienceChange =
    canChangeAudience &&
    editedAudience &&
    !deepEqual(editedAudience, loadedAudience)
      ? editedAudience
      : undefined
  const isDirty = !!changes.threadgate || !!changes.postgate || !!audienceChange

  const audienceNote = !ownAudience
    ? l`A reply is visible to the people who can see its conversation.`
    : l`Changing who can see a post isn’t available yet.`

  const replyText = threadgateFailed
    ? l`Reply settings couldn’t be loaded`
    : {
        anyone: l`Anyone can reply`,
        nobody: l`Replies are off`,
        limited: l`Replies are limited`,
      }[replySummary(threadgateValue)]
  const quoteText = quotesAllowed(postgateValue)
    ? l`Quote posts are allowed`
    : l`Quote posts are off`
  const summary = audienceLabel
    ? l`Shared with ${audienceLabel}. ${replyText}. ${quoteText}.`
    : l`${replyText}. ${quoteText}.`

  const onSave = async () => {
    if (!currentAccount || !isDirty) return
    setIsSaving(true)
    setConflict(false)
    setPendingText(undefined)
    setChangedElsewhere(false)
    try {
      let caughtUp = true
      if (audienceChange) {
        const moved = await changePrivatePostAudience({
          queryClient,
          clients: {did: currentAccount.did, pdsClient, prismClient},
          postUri,
          swapCid: stored?.cid ?? postCid,
          audience: audienceChange,
        })
        caughtUp = moved.caughtUp
      }
      const gatesChanged = !!changes.threadgate || !!changes.postgate
      if (gatesChanged) {
        await savePrivatePostGates({
          pdsClient,
          currentDid: currentAccount.did,
          postUri,
          rootUri: rootPostUri,
          threadgate: changes.threadgate,
          postgate: changes.postgate,
        })
      }
      const did = currentAccount.did
      const invalidate = () => {
        void queryClient.invalidateQueries({
          queryKey: privateGatesQueryKey(rootPostUri),
        })
        void queryClient.invalidateQueries({
          queryKey: [threadgateRecordQueryKeyRoot],
        })
        void queryClient.invalidateQueries({
          queryKey: createPostgateQueryKey(postUri),
        })
        if (audienceChange || gatesChanged) {
          // prism re-evaluates the gates and readership it serves.
          void queryClient.invalidateQueries({
            queryKey: [postThreadQueryKeyRoot],
          })
        }
        if (audienceChange) {
          void queryClient.invalidateQueries({queryKey: postQueryKey(postUri)})
          invalidateAuthorPrivateFeeds(queryClient, did)
        }
      }
      control.close(() => {
        invalidate()
        if (!caughtUp) scheduleMoveRecheck(postUri, invalidate)
      })
    } catch (error) {
      /*
       * A failure after the audience was saved leaves the dialog open on a
       * record that has moved on; read it again so a retry swaps on its
       * current CID and only resends what is still unsaved.
       */
      void ownRecord.refetch()
      if (error instanceof PrivateGateConflictError) {
        setConflict(true)
      } else if (error instanceof PrivatePostPendingError) {
        setPendingText(error.message)
      } else if (error instanceof PrivatePostChangedError) {
        setChangedElsewhere(true)
      } else {
        logger.error('Failed to save private post settings', {
          safeMessage: error,
        })
        Toast.show(
          l`There was an issue. Please check your internet connection and try again.`,
          {type: 'error'},
        )
      }
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog.ScrollableInner
      label={l`Post settings`}
      style={[web({maxWidth: 400}), a.w_full]}>
      {isLoading ? (
        <View
          style={[
            a.flex_1,
            a.py_5xl,
            a.gap_md,
            a.align_center,
            a.justify_center,
          ]}>
          <Loader size="xl" />
          <Text style={[a.italic, a.text_center]}>
            <Trans>Loading post interaction settings...</Trans>
          </Text>
        </View>
      ) : (
        <View style={[a.gap_lg]}>
          <Text style={[a.text_2xl, a.font_bold]}>
            <Trans>Post settings</Trans>
          </Text>
          <View style={[a.gap_sm]}>
            <View style={[a.flex_row]}>
              <AudienceMenu
                visibility="private"
                audience={audienceValue}
                onAudience={canChangeAudience ? setEditedAudience : undefined}
                audienceNote={audienceNote}
                threadgate={threadgateValue}
                onThreadgate={setEditedThreadgate}
                replySettingsDisabled={threadgateFailed || !ownsRoot}
                replySettingsNote={
                  threadgateFailed
                    ? l`Reply settings couldn’t be loaded.`
                    : undefined
                }
                postgate={postgateValue}
                onPostgate={setEditedPostgate}
                fullWidth
              />
            </View>
            <Text
              testID="privatePostSettingsSummary"
              style={[a.text_sm, a.leading_snug, t.atoms.text_contrast_medium]}>
              {summary}
            </Text>
          </View>
          {audienceChange ? (
            <View testID="privatePostAudienceWarning" style={[a.gap_xs]}>
              <Text style={[a.text_sm, a.leading_snug]}>
                {warning.scope === 'branch' ? (
                  <Trans>
                    Replies from people who aren’t in the new audience, and the
                    replies under them, will be hidden from everyone else,
                    including your own replies below theirs.
                  </Trans>
                ) : (
                  <Trans>
                    Replies from people who aren’t in the new audience, and the
                    replies under them, will be hidden from everyone else. Your
                    own replies stay visible.
                  </Trans>
                )}
              </Text>
              {warning.interim ? (
                <Text
                  style={[
                    a.text_sm,
                    a.leading_snug,
                    t.atoms.text_contrast_medium,
                  ]}>
                  <Trans>
                    Until the server fully supports this, replies written before
                    the change may keep the audience they were written under.
                  </Trans>
                </Text>
              ) : null}
            </View>
          ) : null}
          {conflict ? (
            <Text
              style={[
                a.text_sm,
                a.leading_snug,
                {color: t.palette.negative_500},
              ]}>
              <Trans>These settings can’t be saved for this post.</Trans>
            </Text>
          ) : null}
          {pendingText ? (
            <Text
              testID="privatePostPendingText"
              style={[
                a.text_sm,
                a.leading_snug,
                {color: t.palette.negative_500},
              ]}>
              {pendingText}
            </Text>
          ) : null}
          {changedElsewhere ? (
            <Text
              testID="privatePostChangedElsewhere"
              style={[
                a.text_sm,
                a.leading_snug,
                {color: t.palette.negative_500},
              ]}>
              <Trans>
                This post changed since you opened its settings. Close and try
                again.
              </Trans>
            </Text>
          ) : null}
          <Button
            testID="privatePostSettingsSave"
            disabled={!isDirty || isSaving}
            label={l`Save`}
            onPress={() => void onSave()}
            color="primary"
            size="large">
            <ButtonText>
              <Trans>Save</Trans>
            </ButtonText>
            {isSaving && <ButtonIcon icon={Loader} />}
          </Button>
        </View>
      )}
      <Dialog.Close />
    </Dialog.ScrollableInner>
  )
}

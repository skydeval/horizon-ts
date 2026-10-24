/*
 * The composer's audience pieces (4.2, as revised by skydeval's v2 live
 * check 1):
 *
 * - the **visibility control**: for members a Public | Private segmented
 *   control, centred in the footer row between the media tools and the
 *   language and character count, as in the old Horizon client (Comp 13); on
 *   a phone it takes its own centred row above the pills. A reply in a
 *   private thread or branch shows a locked label there instead;
 * - the **audience pill**: the shared drop-down (`AudienceMenu`), in the
 *   pills row above the footer where the stock interaction pill
 *   (`ThreadgateBtn`) sits (Comp 10), at every width. It sets who can reply
 *   and quote for a top-level post and, while Private, who can see, so the
 *   private audience is chosen in the same drop-down.
 *
 * The pieces keep no state of their own: they read and write the composer's
 * visibility record (`state.ts`), whose lifetime the composer owns, and the
 * stock composer state's reply and quote settings through its dispatch. The
 * web footer moves into the active post once a compose has two posts, so the
 * pieces remount and must hold nothing a remount loses.
 *
 * With `COMPOSER_AUDIENCE_MENU` off the composer keeps the stock interaction
 * pill while Public, the drop-down takes the pill's place (who can see only)
 * while Private, and the visibility control sits above the pills at every
 * width.
 *
 * Private follows the account's posting route (2K design 8.1): offered on
 * `locus` once membership is confirmed and on `encode`; not offered yet on
 * `checking`; on `none` the Private segment is shown but inert, and pressing
 * or focusing it shows the route's note under the control row.
 *
 * "Posting as" (Phase 5 design 8.2, 8.5, PA-5, PA-13): every piece reads the
 * **posting** account. With another account chosen, Private follows that
 * account's routes (offered on `locus` only, else "Switch to @other to post
 * privately."), the drop-down lists that account's audiences and lists and
 * saves its defaults, and while the account's reset has not applied, both
 * segments and every drop-down section are held, so nothing chosen in the
 * gap is overwritten when its settings land.
 */

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useSyncExternalStore,
} from 'react'
import {View} from 'react-native'
import {setPostInteractionSettings} from '@bsky/sdk'
import {Trans, useLingui} from '@lingui/react/macro'

import {isNetworkError} from '#/lib/strings/errors'
import {logger} from '#/logger'
import {usePostInteractionSettingsMutation} from '#/state/queries/post-interaction-settings'
import {usePreferencesQuery} from '#/state/queries/preferences'
import {threadgateAllowUISettingToAllowRecordValue} from '#/state/queries/threadgate/util'
import {
  type ComposerAction,
  type ThreadDraft,
} from '#/view/com/composer/state/composer'
import {atoms as a, useBreakpoints, useTheme} from '#/alf'
import * as SegmentedControl from '#/components/forms/SegmentedControl'
import {Lock_Stroke2_Corner0_Rounded as LockIcon} from '#/components/icons/Lock'
import {Text} from '#/components/Typography'
import {usePostingAccount} from '#/horizon/posting-as/account'
import {
  isPostingAsOther,
  useIsResetPending,
  usePostingState,
} from '#/horizon/posting-as/compose-store'
import {
  notePostingSettingsSaved,
  registerPostingComposer,
  setPostingHasVideo,
} from '#/horizon/posting-as/gates'
import {PostingAsNotes} from '#/horizon/posting-as/PostingAsNotes'
import {usePostingCanPostPrivately} from '#/horizon/posting-as/routes'
import {AudienceMenu} from '#/horizon/private/composer/AudienceMenu'
import {
  privateComposeBlocker,
  privateRouteHint,
  privateRouteNote,
} from '#/horizon/private/composer/blockers'
import {isInteractionDirty} from '#/horizon/private/composer/interaction'
import {
  chooseComposeVisibility,
  type ComposeAudience,
  useComposeVisibility,
} from '#/horizon/private/composer/state'
import {useReplyAnchor} from '#/horizon/private/composer/useReplyAnchor'
import {prewarmEncoder} from '#/horizon/private/encoder'
import {usePostAudienceLabel} from '#/horizon/private/render/AudienceLabel'
import {COMPOSER_AUDIENCE_MENU, PRIVATE_POSTING} from '#/horizon/switches'
import {type app} from '#/lexicons'

type ComposerAudienceContext = {
  replyTo: {uri: string} | undefined
  thread: ThreadDraft
  dispatch: (action: ComposerAction) => void
}

const Context = createContext<ComposerAudienceContext | null>(null)

/*
 * Whether the inert Private segment's note is showing: set when the segment
 * is pressed or focused, cleared when it blurs or the control unmounts. Kept
 * outside the pieces because the control and the row that shows the note
 * are separate components.
 */
let inertNoteShown = false
const inertNoteListeners = new Set<() => void>()

function setInertNoteShown(next: boolean) {
  if (inertNoteShown === next) return
  inertNoteShown = next
  inertNoteListeners.forEach(listener => listener())
}

function subscribeInertNote(listener: () => void) {
  inertNoteListeners.add(listener)
  return () => {
    inertNoteListeners.delete(listener)
  }
}

function useInertNoteShown(): boolean {
  return useSyncExternalStore(subscribeInertNote, () => inertNoteShown)
}

/**
 * Hands the composer's reply target, thread and dispatch to the pieces.
 * Holds no state. While the composer is open with Private offered on posting
 * route `encode`, whatever the segment, it pre-warms the encoder (2K design
 * PA-30), so the encoder is loaded before Post is pressed; keyed on the
 * route, so a route that becomes `encode` with the composer open pre-warms
 * then. Idempotent; a failure is logged and the compose loads again.
 */
export function ComposerAudienceProvider({
  replyTo,
  thread,
  dispatch,
  children,
}: ComposerAudienceContext & {children: React.ReactNode}) {
  const can = usePostingCanPostPrivately()
  const prewarms = PRIVATE_POSTING && can.offered && can.route === 'encode'
  useEffect(() => {
    if (prewarms) prewarmEncoder()
  }, [prewarms])
  // The "Posting as" reset dispatches into this composer (Phase 5 8.2).
  const replyToUri = replyTo?.uri
  useLayoutEffect(
    () => registerPostingComposer({dispatch, replyTo: replyToUri}),
    [dispatch, replyToUri],
  )
  // A video was uploaded as the current account (Phase 5 8.5).
  const hasVideo = thread.posts.some(post => post.embed.media?.type === 'video')
  useLayoutEffect(() => {
    setPostingHasVideo(hasVideo)
  }, [hasVideo])
  return (
    <Context.Provider value={{replyTo, thread, dispatch}}>
      {children}
    </Context.Provider>
  )
}

/**
 * Whether each piece has anything to show.
 */
function useControlState() {
  const context = useContext(Context)
  /*
   * A membership only persisted on the device does not offer Private yet,
   * and neither does a posting route that cannot write it (2K design 2.3).
   * The posting account's, with another account chosen (Phase 5 8.5).
   */
  const can = usePostingCanPostPrivately()
  // Until the posting account's reset has applied (Phase 5 P5R5-N1).
  const held = useIsResetPending()
  const isMember = can.offered
  const compose = useComposeVisibility()
  const isPrivate = compose.visibility === 'private'
  const isReply = !!context?.replyTo
  const locked = PRIVATE_POSTING && compose.locked
  /** Private shown on posting route `none`, but not choosable (8.1). */
  const inert =
    PRIVATE_POSTING &&
    !locked &&
    !can.offered &&
    can.route === 'none' &&
    can.showsRouteNote
  const showsSegments =
    PRIVATE_POSTING && !locked && (isMember || isPrivate || inert)
  /*
   * The drop-down has something to set: a top-level compose (who can reply
   * and quote, and for a private one who can see), or a reply to a public
   * post composed Private, which starts a branch (who can see). A locked
   * reply names its anchor's audience and sets nothing. With the menu off it
   * serves Private only.
   */
  const showsPill =
    !!context &&
    !locked &&
    (COMPOSER_AUDIENCE_MENU
      ? !isReply || (PRIVATE_POSTING && isPrivate)
      : PRIVATE_POSTING && isPrivate)
  const showsVisibility = !!context && (locked || showsSegments)
  return {
    context,
    compose,
    isPrivate,
    isReply,
    showsSegments,
    showsPill,
    showsVisibility,
    locked,
    inert,
    routes: can.routes,
    handle: can.handle,
    held,
  }
}

/**
 * Whether the pills row holds the audience drop-down (for `ComposerPills`,
 * which renders nothing when it holds no pill at all).
 */
export function useShowsComposerAudiencePill(): boolean {
  return useControlState().showsPill
}

/**
 * Rendered above the composer's pills (Comp 7): on a phone (or with the menu
 * off) the visibility control in its own centred row; on every width the
 * private blocker message, and the inert Private segment's note, so neither
 * is ever squeezed into the footer row.
 */
export function ComposerAudienceRow() {
  const t = useTheme()
  const {gtPhone} = useBreakpoints()
  const state = useControlState()
  const noteShown = useInertNoteShown()
  if (!state.context) return null
  const inRow = state.showsVisibility && (!gtPhone || !COMPOSER_AUDIENCE_MENU)
  const blocker =
    PRIVATE_POSTING && state.isPrivate
      ? privateComposeBlocker(
          state.context.thread,
          state.routes,
          state.compose.audience,
          state.handle,
        )
      : undefined
  const note =
    !blocker && state.inert && noteShown
      ? privateRouteNote(state.routes, state.handle)
      : undefined
  return (
    <View style={[t.atoms.bg]}>
      {/* The posting account's own notes (Phase 5 8.2) */}
      <PostingAsNotes />
      {inRow ? (
        <View
          style={[
            a.flex_row,
            a.justify_center,
            a.align_center,
            a.gap_sm,
            a.px_md,
            a.py_xs,
          ]}>
          <VisibilityControl />
        </View>
      ) : null}
      {blocker ? (
        <View style={[a.px_md, a.pb_xs]}>
          <Text
            style={[
              a.text_sm,
              a.leading_snug,
              {color: t.palette.negative_500},
            ]}>
            {blocker}
          </Text>
        </View>
      ) : null}
      {note ? (
        <View style={[a.px_md, a.pb_xs]}>
          <Text
            testID="composerPrivateRouteNote"
            style={[a.text_sm, a.leading_snug, t.atoms.text_contrast_medium]}>
            {note}
          </Text>
        </View>
      ) : null}
    </View>
  )
}

/**
 * Rendered in the footer row between the media tools and the right-hand
 * group (Comp 13): a `flex_1` centred slot holding the visibility control on
 * wider screens, so it sits centred between the stock groups.
 */
export function ComposerAudienceSlot() {
  const {gtPhone} = useBreakpoints()
  const state = useControlState()
  if (!COMPOSER_AUDIENCE_MENU || !state.context) return null
  return (
    <View
      style={[
        a.flex_1,
        a.flex_row,
        a.justify_center,
        a.align_center,
        a.gap_sm,
        a.px_sm,
        a.overflow_hidden,
      ]}>
      {gtPhone && state.showsVisibility ? <VisibilityControl /> : null}
    </View>
  )
}

/**
 * The Public | Private segmented control, or a locked reply's label. On
 * posting route `none` the Private segment stays focusable but choosing it
 * only shows the note, every time.
 */
function VisibilityControl() {
  const {t: l} = useLingui()
  const {context, compose, showsSegments, locked, inert, held} =
    useControlState()
  // The note never outlives the control (a remount, the composer closing).
  useEffect(() => () => setInertNoteShown(false), [])
  if (!context) return null

  if (locked) {
    return (
      <LockedReplyLabel
        replyToUri={context.replyTo?.uri}
        audience={compose.audience}
      />
    )
  }
  if (!showsSegments) return null
  return (
    <SegmentedControl.Root
      type="radio"
      size="small"
      label={l`Post visibility`}
      value={compose.visibility}
      style={[{maxWidth: 160}]}
      onChange={visibility => {
        // Held until the posting account's reset has applied (P5R5-N1).
        if (held) return
        if (inert && visibility === 'private') {
          setInertNoteShown(true)
          return
        }
        chooseComposeVisibility({visibility})
      }}>
      <SegmentedControl.Item
        testID="composerVisibilityPublic"
        value="public"
        disabled={held}
        label={l`Public`}>
        <SegmentedControl.ItemText>{l`Public`}</SegmentedControl.ItemText>
      </SegmentedControl.Item>
      <SegmentedControl.Item
        testID="composerVisibilityPrivate"
        value="private"
        disabled={held}
        label={l`Private`}
        accessibilityHint={inert ? privateRouteHint() : undefined}
        onFocus={inert ? () => setInertNoteShown(true) : undefined}
        onBlur={inert ? () => setInertNoteShown(false) : undefined}>
        <SegmentedControl.ItemText>{l`Private`}</SegmentedControl.ItemText>
      </SegmentedControl.Item>
    </SegmentedControl.Root>
  )
}

/**
 * The audience drop-down in the pills row, where the stock interaction pill
 * sits (Comp 10). Its trigger reads the interaction summary in both
 * visibilities, and the audience only on a private reply that starts a
 * branch, where the menu has no reply section.
 */
export function ComposerAudiencePill() {
  const {context, compose, isPrivate, isReply, showsPill, held, handle} =
    useControlState()
  const {data: preferences} = usePreferencesQuery()
  const {mutate: persistDefaults} = usePostInteractionSettingsMutation({
    onError: error => {
      if (!isNetworkError(error)) {
        logger.error('Failed to persist threadgate settings', {
          safeMessage: error,
        })
      }
    },
  })
  /*
   * Another posting account (Phase 5 8.2, PA-13): its own settings for the
   * dirty check, saved through its own client, never the current account's.
   */
  const account = usePostingAccount()
  const posting = usePostingState()
  if (!context || !showsPill) return null

  const {thread, dispatch} = context
  /*
   * The stock composer offers reply and quote settings for top-level posts
   * only, in both visibilities.
   */
  const interactions = COMPOSER_AUDIENCE_MENU && !isReply
  const threadgate = interactions ? thread.threadgate : undefined
  const postgate = interactions ? thread.postgate : undefined
  const settings = account
    ? posting.settings
    : preferences?.postInteractionSettings

  const saveDefaults = (
    next: app.bsky.actor.defs.PostInteractionSettingsPref,
  ) => {
    if (!account) {
      persistDefaults(next)
      return
    }
    account.pdsClient.call(setPostInteractionSettings, next).then(
      () => notePostingSettingsSaved(account.did, next),
      (error: unknown) => {
        if (!isNetworkError(error)) {
          logger.error('Failed to persist threadgate settings', {
            safeMessage: error,
          })
        }
      },
    )
  }

  return (
    <AudienceMenu
      visibility={PRIVATE_POSTING && isPrivate ? 'private' : 'public'}
      audience={compose.audience}
      onAudience={audience => chooseComposeVisibility({audience})}
      threadgate={threadgate}
      onThreadgate={next =>
        dispatch({type: 'update_threadgate', threadgate: next})
      }
      postgate={postgate}
      onPostgate={next => dispatch({type: 'update_postgate', postgate: next})}
      defaults={
        // Never the current account's defaults for another posting account.
        threadgate && postgate && (account || !isPostingAsOther(posting))
          ? {
              isDirty: isInteractionDirty(settings, threadgate, postgate),
              onSave: () =>
                saveDefaults({
                  threadgateAllowRules:
                    threadgateAllowUISettingToAllowRecordValue(threadgate),
                  postgateEmbeddingRules: postgate.embeddingRules ?? [],
                }),
            }
          : undefined
      }
      account={account}
      held={
        // Another account without its clients reads as held, never as the current one.
        held || (isPostingAsOther(posting) && !account)
          ? {failed: posting.hold.kind === 'failed', handle}
          : undefined
      }
      nudge={interactions}
      reportMetrics={interactions}
    />
  )
}

/**
 * A reply in a private thread or branch: Private under its anchor's
 * audience, shown with a lock and not pressable.
 */
function LockedReplyLabel({
  replyToUri,
  audience,
}: {
  replyToUri: string | undefined
  audience: ComposeAudience
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  /*
   * The anchor's audience (the thread root's, or the branch root's), labelled
   * as on the post (7.2); the parent's until the anchor is read, and a
   * neutral label while nothing is known or when it cannot be read.
   */
  const anchor = useReplyAnchor(replyToUri)
  const label =
    usePostAudienceLabel(
      anchor?.uri ?? replyToUri,
      anchor?.audienceUri ??
        (audience.kind === 'parent' ? audience.uri : undefined),
    ) ?? l`the people who can see this conversation`

  return (
    <View
      accessible
      accessibilityLabel={l`Private reply, shared with ${label}`}
      accessibilityHint={l`A reply to a private post stays private and can’t be changed to public`}
      style={[a.flex_row, a.align_center, a.gap_xs, a.flex_shrink]}>
      <LockIcon size="sm" style={[t.atoms.text_contrast_medium]} />
      <Text style={[a.text_sm, a.font_semi_bold]}>
        <Trans>Private</Trans>
      </Text>
      <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>&middot;</Text>
      <Text
        style={[a.text_sm, a.flex_shrink, t.atoms.text_contrast_medium]}
        numberOfLines={1}>
        {label}
      </Text>
    </View>
  )
}

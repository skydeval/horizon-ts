/*
 * The audience drop-down (4.2.1): one menu for both visibilities. A private
 * post sets who can see it; any top-level post sets who can reply and who
 * can quote, which are the stock threadgate and postgate settings, covering
 * everything the stock interaction dialog sets (4.2.2). Used by the composer,
 * in the pills row where the stock interaction pill sits, and by the post
 * settings dialog (7.8).
 *
 * On web every choice keeps the menu open (its press is default-prevented,
 * which `Menu.Item` honours): radio and checkbox items in every section, and
 * saving the defaults, so several settings can be made in one opening
 * (skydeval, 2026-10-18). The menu closes on a click outside it or on its
 * trigger. "New audience..." and "New reply list..." close it, since they
 * open a dialog. Native menus close on every press.
 */

import {useEffect, useRef, useState} from 'react'
import {ActivityIndicator, type GestureResponderEvent, View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {type ThreadgateAllowUISetting} from '#/state/queries/threadgate/types'
import {UserAvatar} from '#/view/com/util/UserAvatar'
import {atoms as a, useTheme, web} from '#/alf'
import {Button, ButtonIcon, ButtonText} from '#/components/Button'
import * as Dialog from '#/components/Dialog'
import {Check_Stroke2_Corner0_Rounded as CheckIcon} from '#/components/icons/Check'
import {TinyChevronBottom_Stroke2_Corner0_Rounded as TinyChevronIcon} from '#/components/icons/Chevron'
import {Earth_Stroke2_Corner0_Rounded as EarthIcon} from '#/components/icons/Globe'
import {Group3_Stroke2_Corner0_Rounded as GroupIcon} from '#/components/icons/Group'
import {
  ListPlus_Stroke2_Corner0_Rounded as ListPlusIcon,
  ListSparkle_Stroke2_Corner0_Rounded as ListIcon,
} from '#/components/icons/List'
import {Lock_Stroke2_Corner0_Rounded as LockIcon} from '#/components/icons/Lock'
import {
  Person_Stroke2_Corner0_Rounded as PersonIcon,
  PersonCheck_Stroke2_Corner0_Rounded as PersonCheckIcon,
  PersonGroup_Stroke2_Corner2_Rounded as PersonGroupIcon,
} from '#/components/icons/Person'
import {CloseQuote_Stroke2_Corner1_Rounded as QuoteIcon} from '#/components/icons/Quote'
import * as Menu from '#/components/Menu'
import * as Tooltip from '#/components/Tooltip'
import {Text} from '#/components/Typography'
import {useAnalytics} from '#/analytics'
import {
  type PostingAccount,
  usePostingCurateLists,
} from '#/horizon/posting-as/account'
import {retryPostingReads} from '#/horizon/posting-as/gates'
import {
  type AudienceEntry,
  audienceLabel,
  type StandingMode,
} from '#/horizon/private/api/audiences'
import {AudienceEditorDialog} from '#/horizon/private/audiences/AudienceEditorDialog'
import {useAudiencesQuery} from '#/horizon/private/audiences/useAudiencesQuery'
import {
  applyReplyChoice,
  audienceTriggerReads,
  canToggleReplyValue,
  interactionSummary,
  quotesAllowed,
  type ReplyChoice,
  type ReplyValue,
  replyValues,
  withQuotesAllowed,
} from '#/horizon/private/composer/interaction'
import {type ComposeAudience} from '#/horizon/private/composer/state'
import {type app} from '#/lexicons'
import {useThreadgateNudged} from '#/storage/hooks/threadgate-nudged'

export type AudienceMenuProps = {
  visibility: 'public' | 'private'
  /** Who can see (private only). */
  audience?: ComposeAudience
  /** Absent: the who-can-see section is read-only. */
  onAudience?: (next: ComposeAudience) => void
  /** Shown under a read-only who-can-see section. */
  audienceNote?: string
  /** Undefined: no reply section. */
  threadgate: ThreadgateAllowUISetting[] | undefined
  onThreadgate: (next: ThreadgateAllowUISetting[]) => void
  /** The reply section is shown but cannot be changed (7.8). */
  replySettingsDisabled?: boolean
  /** Why it cannot; the stock wording when absent. */
  replySettingsNote?: string
  /** Undefined: no quote section. */
  postgate: app.bsky.feed.postgate.Main | undefined
  onPostgate: (next: app.bsky.feed.postgate.Main) => void
  /** The composer's "save as default" (absent elsewhere). */
  defaults?: {isDirty: boolean; onSave: () => void}
  /** Show the stock first-use tooltip on the trigger (composer only). */
  nudge?: boolean
  /** Opening and closing are reported as the stock composer metrics. */
  reportMetrics?: boolean
  /** The trigger fills its container (the post settings dialog). */
  fullWidth?: boolean
  /**
   * The composer's posting account when it is not the current account
   * (Phase 5 8.2, PA-13): its audiences and lists, created in its repo.
   */
  account?: PostingAccount
  /**
   * Every section held (spinner, nothing pickable) until the posting
   * account's reset has applied; `failed` when a read failed (P5R4-L1).
   */
  held?: {failed: boolean; handle: string | undefined}
}

/**
 * The labels of the standing audiences.
 */
export function useModeLabel() {
  const {t: l} = useLingui()
  return (mode: StandingMode) => {
    switch (mode) {
      case 'everyone':
        return l`Horizon members`
      case 'followers':
        return l`Followers`
      case 'following':
        return l`People you follow`
      case 'nobody':
        return l`Only me`
    }
  }
}

/**
 * A list audience's name, as the drop-down shows it.
 */
export function listName(entry: AudienceEntry | undefined) {
  if (!entry) return undefined
  return audienceLabel(entry, {isSelf: true})
}

/**
 * The list audiences offered under Who can see: named lists.
 */
export function pickableListAudiences(
  audiences: AudienceEntry[] | undefined,
): AudienceEntry[] {
  return (audiences ?? []).filter(
    entry => entry.mode === 'list' && entry.name !== undefined,
  )
}

/**
 * The label of a private compose's audience, as the trigger shows it.
 */
function useAudienceText(
  audience: ComposeAudience | undefined,
  audiences: AudienceEntry[] | undefined,
): string {
  const {t: l} = useLingui()
  const modeLabel = useModeLabel()
  if (!audience) return l`Horizon members`
  if (audience.kind === 'mode') return modeLabel(audience.mode)
  if (audience.kind === 'list') {
    return (
      listName(audiences?.find(entry => entry.uri === audience.uri)) ?? l`List`
    )
  }
  if (audience.kind === 'unpicked') return l`Choose who can see this`
  return l`Same as the post you’re replying to`
}

/**
 * The icon beside a private compose's audience on the trigger: a lock for
 * Horizon members (or the post being replied to), people for Followers, a
 * person with a check for People you follow, a list for a named audience, a
 * person for Only me.
 */
export function audienceIconOf(audience: ComposeAudience | undefined) {
  if (!audience) return LockIcon
  switch (audience.kind) {
    case 'mode':
      switch (audience.mode) {
        case 'everyone':
          return LockIcon
        case 'followers':
          return PersonGroupIcon
        case 'following':
          return PersonCheckIcon
        case 'nobody':
          return PersonIcon
      }
      return LockIcon
    case 'list':
      return ListIcon
    case 'parent':
      return LockIcon
    case 'unpicked':
      return PersonGroupIcon
  }
}

/**
 * The checkbox mark of a menu item: the size of `Menu.ItemRadio`.
 */
export function MenuCheck({selected}: {selected: boolean}) {
  const t = useTheme()
  return (
    <View
      style={[
        a.justify_center,
        a.align_center,
        a.rounded_xs,
        {height: 20, width: 20},
        selected
          ? {backgroundColor: t.palette.primary_500}
          : [t.atoms.border_contrast_high, {borderWidth: 1}],
      ]}>
      {selected ? <CheckIcon size="xs" fill={t.palette.white} /> : null}
    </View>
  )
}

/**
 * The drop-down: a trigger button and its menu. See the file header.
 */
export function AudienceMenu({
  visibility,
  audience,
  onAudience,
  audienceNote,
  threadgate,
  onThreadgate,
  replySettingsDisabled = false,
  replySettingsNote,
  postgate,
  onPostgate,
  defaults,
  nudge = false,
  reportMetrics = false,
  fullWidth = false,
  account,
  held,
}: AudienceMenuProps) {
  const {t: l} = useLingui()
  const ax = useAnalytics()
  const control = Menu.useMenuControl()
  const audienceEditor = Dialog.useDialogControl()
  const replyListEditor = Dialog.useDialogControl()
  const isPrivate = visibility === 'private'
  const {data: audiences} = useAudiencesQuery({
    enabled: isPrivate && !held,
    account,
  })
  const audienceText = useAudienceText(audience, audiences)
  /** Names of reply lists made here, until the AppView lists them. */
  const [createdLists, setCreatedLists] = useState<Record<string, string>>({})

  const [threadgateNudged, setThreadgateNudged] = useThreadgateNudged()
  const [showTooltip, setShowTooltip] = useState(false)
  // eslint-disable-next-line react/hook-use-state
  const [tooltipWasShown] = useState(nudge && !threadgateNudged)
  useEffect(() => {
    if (!nudge || threadgateNudged) return
    const timeout = setTimeout(() => setShowTooltip(true), 1000)
    return () => clearTimeout(timeout)
  }, [nudge, threadgateNudged])

  /*
   * The stock composer reports opening its interaction dialog and saving it;
   * the menu reports opening and closing.
   */
  const wasOpen = useRef(false)
  const opened = useRef({threadgate, postgate})
  useEffect(() => {
    if (!reportMetrics) return
    if (control.isOpen && !wasOpen.current) {
      opened.current = {threadgate, postgate}
      ax.metric('composer:threadgate:open', {nudged: tooltipWasShown})
    } else if (!control.isOpen && wasOpen.current && threadgate && postgate) {
      ax.metric('composer:threadgate:save', {
        replyOptions: threadgate.map(setting => setting.type).join(','),
        quotesEnabled: quotesAllowed(postgate),
        persist: false,
        hasChanged:
          opened.current.threadgate !== threadgate ||
          opened.current.postgate !== postgate,
      })
    }
    wasOpen.current = !!control.isOpen
  }, [ax, control.isOpen, reportMetrics, threadgate, postgate, tooltipWasShown])

  const hasLimits =
    !!threadgate && interactionSummary(threadgate, postgate) === 'limited'
  const summaryText = hasLimits
    ? l`Interaction limited`
    : l`Anyone can interact`
  /*
   * A private post shows its interaction summary and its audience side by
   * side (skydeval, 2026-10-27); while no audience is chosen, the trigger
   * asks for one alone (P5R7-L1).
   */
  const reads = audienceTriggerReads({
    isPrivate,
    hasReplySection: !!threadgate,
    audiencePicked: audience?.kind !== 'unpicked',
  })
  const accessibilityLabel = isPrivate
    ? threadgate
      ? l`Audience: ${audienceText}. ${summaryText}.`
      : l`Audience: ${audienceText}.`
    : summaryText
  const summaryIcon = hasLimits ? GroupIcon : EarthIcon
  const audienceIcon = audienceIconOf(audience)

  const onDismissTooltip = (visible: boolean) => {
    if (visible) return
    setThreadgateNudged(true)
    setShowTooltip(false)
  }

  const trigger = (
    <Menu.Trigger
      label={accessibilityLabel}
      hint={
        isPrivate
          ? l`Opens a menu to choose who can see, reply to and quote this post`
          : l`Opens a menu to choose who can reply to and quote this post`
      }>
      {({props}) => (
        <Button
          {...props}
          onPress={() => {
            if (nudge) {
              setShowTooltip(false)
              setThreadgateNudged(true)
            }
            props.onPress()
          }}
          testID="composerAudienceButton"
          color={showTooltip ? 'primary_subtle' : 'secondary'}
          size="small"
          label={accessibilityLabel}
          style={[a.flex_shrink, fullWidth && a.w_full]}>
          {reads !== 'audience' ? (
            <>
              <ButtonIcon icon={summaryIcon} />
              <ButtonText
                numberOfLines={1}
                maxFontSizeMultiplier={2}
                style={[a.flex_shrink]}>
                {summaryText}
              </ButtonText>
            </>
          ) : null}
          {reads === 'both' ? (
            <ButtonText
              aria-hidden
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              maxFontSizeMultiplier={2}>
              ·
            </ButtonText>
          ) : null}
          {reads !== 'summary' ? (
            <>
              <ButtonIcon icon={audienceIcon} />
              <ButtonText
                testID="composerAudienceButtonAudience"
                numberOfLines={1}
                maxFontSizeMultiplier={2}
                style={[a.flex_shrink]}>
                {audienceText}
              </ButtonText>
            </>
          ) : null}
          <ButtonIcon icon={TinyChevronIcon} size="2xs" />
        </Button>
      )}
    </Menu.Trigger>
  )

  return (
    <>
      <Menu.Root control={control}>
        {nudge ? (
          <Tooltip.Outer
            visible={showTooltip}
            onVisibleChange={onDismissTooltip}
            position="top">
            <Tooltip.Target>{trigger}</Tooltip.Target>
            <Tooltip.BubbleText
              label={l`Psst! You can edit who can interact with this post.`}>
              <Trans>Psst! You can edit who can interact with this post.</Trans>
            </Tooltip.BubbleText>
          </Tooltip.Outer>
        ) : (
          trigger
        )}
        <Menu.Outer
          style={[
            {minWidth: 260, maxWidth: 360},
            /*
             * The menu scrolls when it is taller than the window. A fixed
             * width and a reserved, thin scrollbar keep its layout the same
             * whether it scrolls or not: without them, the scrollbar that
             * appears when the rows change (for example the "Save these
             * options" row) narrows the content and rewraps it.
             */
            web({
              width: 320,
              scrollbarGutter: 'stable',
              scrollbarWidth: 'thin',
            }),
          ]}>
          {held ? <HeldSections held={held} /> : null}
          {!held && isPrivate && audience ? (
            <WhoCanSee
              audience={audience}
              audiences={audiences}
              onAudience={onAudience}
              audienceNote={audienceNote}
              onNewList={() => audienceEditor.open()}
            />
          ) : null}
          {!held && threadgate ? (
            <>
              {isPrivate && audience ? <Menu.Divider /> : null}
              <WhoCanReply
                threadgate={threadgate}
                onThreadgate={onThreadgate}
                disabled={replySettingsDisabled}
                note={replySettingsNote}
                createdLists={createdLists}
                onNewList={() => replyListEditor.open()}
              />
            </>
          ) : null}
          {!held && postgate ? (
            <>
              <Menu.Divider />
              <Menu.Group>
                <Menu.LabelText>
                  <Trans>Quotes</Trans>
                </Menu.LabelText>
                <Menu.Item
                  testID="composerAllowQuotes"
                  label={
                    quotesAllowed(postgate)
                      ? l`Disable quote posts of this post`
                      : l`Enable quote posts of this post`
                  }
                  onPress={(e: GestureResponderEvent) => {
                    e.preventDefault()
                    onPostgate(
                      withQuotesAllowed(postgate, !quotesAllowed(postgate)),
                    )
                  }}>
                  <Menu.ItemIcon icon={QuoteIcon} />
                  <Menu.ItemText>
                    <Trans>Allow quote posts</Trans>
                  </Menu.ItemText>
                  <MenuCheck selected={quotesAllowed(postgate)} />
                </Menu.Item>
              </Menu.Group>
            </>
          ) : null}
          {!held && defaults && threadgate ? (
            <>
              <Menu.Divider />
              <Menu.Group>
                {defaults.isDirty ? (
                  <Menu.Item
                    testID="composerSaveInteractionDefaults"
                    label={l`Save these options for next time`}
                    onPress={(e: GestureResponderEvent) => {
                      // Stays open; the row turns into the saved note.
                      e.preventDefault()
                      defaults.onSave()
                    }}>
                    <Menu.ItemText>
                      <Trans>Save these options for next time</Trans>
                    </Menu.ItemText>
                  </Menu.Item>
                ) : (
                  <Menu.LabelText>
                    <Trans>These are your default settings</Trans>
                  </Menu.LabelText>
                )}
              </Menu.Group>
            </>
          ) : null}
        </Menu.Outer>
      </Menu.Root>
      {onAudience ? (
        <AudienceEditorDialog
          control={audienceEditor}
          kind="audience"
          account={account}
          onCreated={uri => onAudience({kind: 'list', uri})}
        />
      ) : null}
      {threadgate && !replySettingsDisabled ? (
        <AudienceEditorDialog
          control={replyListEditor}
          kind="replyList"
          account={account}
          onCreated={(uri, name) => {
            setCreatedLists(current => ({...current, [uri]: name}))
            onThreadgate(
              applyReplyChoice(threadgate, {
                type: 'toggle',
                value: `list:${uri}`,
              }),
            )
          }}
        />
      ) : null}
    </>
  )
}

/**
 * In place of every section while the posting account's reset has not
 * applied (Phase 5 P5R4-L1): a spinner, or the failed read's note and Try
 * again. Nothing here picks an audience or a setting.
 */
function HeldSections({
  held,
}: {
  held: {failed: boolean; handle: string | undefined}
}) {
  const {t: l} = useLingui()
  const handle = held.handle ? `@${held.handle}` : l`that account`
  return (
    <Menu.Group>
      {held.failed ? (
        <>
          <Menu.LabelText>{l`Couldn’t load ${handle}’s settings.`}</Menu.LabelText>
          <Menu.Item
            testID="composerAudienceHeldRetry"
            label={l`Try loading the settings again`}
            onPress={() => retryPostingReads()}>
            <Menu.ItemText>
              <Trans>Try again</Trans>
            </Menu.ItemText>
          </Menu.Item>
        </>
      ) : (
        <View
          testID="composerAudienceHeld"
          style={[a.flex_row, a.align_center, a.gap_sm, a.px_md, a.py_sm]}>
          <ActivityIndicator size="small" />
          <Text style={[a.text_sm]}>{l`Loading ${handle}’s settings…`}</Text>
        </View>
      )}
    </Menu.Group>
  )
}

function WhoCanSee({
  audience,
  audiences,
  onAudience,
  audienceNote,
  onNewList,
}: {
  audience: ComposeAudience
  audiences: AudienceEntry[] | undefined
  onAudience: ((next: ComposeAudience) => void) | undefined
  audienceNote: string | undefined
  onNewList: () => void
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const readOnly = !onAudience
  const lists = pickableListAudiences(audiences)
  const isMode = (mode: StandingMode) =>
    audience.kind === 'mode' && audience.mode === mode
  // Choosing keeps the menu open on web (see the file comment).
  const pick = (e: GestureResponderEvent, next: ComposeAudience) => {
    e.preventDefault()
    onAudience?.(next)
  }

  return (
    <Menu.Group>
      <Menu.LabelText>
        <Trans>Who can see</Trans>
      </Menu.LabelText>
      <Menu.Item
        label={l`Horizon members`}
        disabled={readOnly}
        onPress={e => pick(e, {kind: 'mode', mode: 'everyone'})}>
        <View style={[a.flex_1, a.gap_2xs]}>
          <Menu.ItemText>
            <Trans>Horizon members</Trans>
          </Menu.ItemText>
          <Text
            style={[a.text_xs, a.leading_snug, t.atoms.text_contrast_medium]}>
            <Trans>Everyone who can see private posts</Trans>
          </Text>
        </View>
        <Menu.ItemRadio selected={isMode('everyone')} />
      </Menu.Item>
      <Menu.Item
        label={l`Followers`}
        disabled={readOnly}
        onPress={e => pick(e, {kind: 'mode', mode: 'followers'})}>
        <Menu.ItemText>
          <Trans>Followers</Trans>
        </Menu.ItemText>
        <Menu.ItemRadio selected={isMode('followers')} />
      </Menu.Item>
      <Menu.Item
        label={l`People you follow`}
        disabled={readOnly}
        onPress={e => pick(e, {kind: 'mode', mode: 'following'})}>
        <Menu.ItemText>
          <Trans>People you follow</Trans>
        </Menu.ItemText>
        <Menu.ItemRadio selected={isMode('following')} />
      </Menu.Item>
      {lists.map(entry => {
        const name = listName(entry) ?? ''
        return (
          <Menu.Item
            key={entry.uri}
            label={l`List: ${name}`}
            disabled={readOnly}
            onPress={e => pick(e, {kind: 'list', uri: entry.uri})}>
            <Menu.ItemText>{name}</Menu.ItemText>
            <Menu.ItemRadio
              selected={audience.kind === 'list' && audience.uri === entry.uri}
            />
          </Menu.Item>
        )
      })}
      {readOnly ? null : (
        <Menu.Item
          testID="composerNewAudience"
          label={l`New audience…`}
          onPress={onNewList}>
          <Menu.ItemText>
            <Trans>New audience…</Trans>
          </Menu.ItemText>
          <Menu.ItemIcon icon={ListPlusIcon} position="right" />
        </Menu.Item>
      )}
      <Menu.Item
        label={l`Only me`}
        disabled={readOnly}
        onPress={e => pick(e, {kind: 'mode', mode: 'nobody'})}>
        <Menu.ItemText>
          <Trans>Only me</Trans>
        </Menu.ItemText>
        <Menu.ItemIcon icon={PersonIcon} position="right" />
        <Menu.ItemRadio selected={isMode('nobody')} />
      </Menu.Item>
      {readOnly && audienceNote ? (
        <Menu.LabelText>{audienceNote}</Menu.LabelText>
      ) : null}
    </Menu.Group>
  )
}

function WhoCanReply({
  threadgate,
  onThreadgate,
  disabled,
  note,
  createdLists,
  onNewList,
}: {
  threadgate: ThreadgateAllowUISetting[]
  onThreadgate: (next: ThreadgateAllowUISetting[]) => void
  disabled: boolean
  note: string | undefined
  createdLists: Record<string, string>
  onNewList: () => void
}) {
  const {t: l} = useLingui()
  // The posting account's lists (Phase 5 8.2, PA-13).
  const {
    data: lists,
    isPending: isListsPending,
    isError: isListsError,
  } = usePostingCurateLists()
  const checked = replyValues(threadgate)
  const anyone = threadgate.some(setting => setting.type === 'everybody')
  const nobody = threadgate.some(setting => setting.type === 'nobody')

  // Every choice keeps the menu open on web (see the file comment).
  const choose = (e: GestureResponderEvent, choice: ReplyChoice) => {
    e.preventDefault()
    onThreadgate(applyReplyChoice(threadgate, choice))
  }
  const toggle = (e: GestureResponderEvent, value: ReplyValue) =>
    choose(e, {type: 'toggle', value})
  const isChecked = (value: ReplyValue) => checked.includes(value)
  const canToggle = (value: ReplyValue) =>
    !disabled && canToggleReplyValue(threadgate, value)

  const listedUris = new Set((lists ?? []).map(list => list.uri as string))
  /*
   * A checked list the AppView does not return yet (a list just made here,
   * or one restored with a draft) is still shown, so it can be unchecked.
   */
  const unlisted = checked
    .filter(value => value.startsWith('list:'))
    .map(value => value.slice('list:'.length))
    .filter(uri => !listedUris.has(uri))

  return (
    <Menu.Group>
      <Menu.LabelText>
        <Trans>Who can reply</Trans>
      </Menu.LabelText>
      {disabled ? (
        <Menu.LabelText>
          {note ?? l`Reply settings are chosen by the author of the thread`}
        </Menu.LabelText>
      ) : null}
      <Menu.Item
        testID="composerReplyAnyone"
        label={l`Allow anyone to reply`}
        disabled={disabled}
        onPress={e => choose(e, {type: 'everybody'})}>
        <Menu.ItemText>
          <Trans>Anyone</Trans>
        </Menu.ItemText>
        <Menu.ItemRadio selected={anyone} />
      </Menu.Item>
      <Menu.Item
        testID="composerReplyNobody"
        label={l`Disable replies entirely`}
        disabled={disabled}
        onPress={e => choose(e, {type: 'nobody'})}>
        <Menu.ItemText>
          <Trans>Nobody</Trans>
        </Menu.ItemText>
        <Menu.ItemRadio selected={nobody} />
      </Menu.Item>
      <Menu.Item
        label={l`Allow your followers to reply`}
        disabled={!canToggle('followers')}
        onPress={e => toggle(e, 'followers')}>
        <Menu.ItemText>
          <Trans>Your followers</Trans>
        </Menu.ItemText>
        <MenuCheck selected={isChecked('followers')} />
      </Menu.Item>
      <Menu.Item
        label={l`Allow people you follow to reply`}
        disabled={!canToggle('following')}
        onPress={e => toggle(e, 'following')}>
        <Menu.ItemText>
          <Trans>People you follow</Trans>
        </Menu.ItemText>
        <MenuCheck selected={isChecked('following')} />
      </Menu.Item>
      <Menu.Item
        label={l`Allow people you mention to reply`}
        disabled={!canToggle('mention')}
        onPress={e => toggle(e, 'mention')}>
        <Menu.ItemText>
          <Trans>People you mention</Trans>
        </Menu.ItemText>
        <MenuCheck selected={isChecked('mention')} />
      </Menu.Item>
      <Menu.LabelText>
        <Trans>Your lists</Trans>
      </Menu.LabelText>
      {isListsPending ? (
        <Menu.LabelText>
          <Trans>Loading lists...</Trans>
        </Menu.LabelText>
      ) : isListsError ? (
        <Menu.LabelText>
          <Trans>An error occurred while loading your lists :/</Trans>
        </Menu.LabelText>
      ) : lists.length === 0 && unlisted.length === 0 ? (
        <Menu.LabelText>
          <Trans>You don't have any lists yet.</Trans>
        </Menu.LabelText>
      ) : null}
      {(lists ?? []).map(list => {
        const value: ReplyValue = `list:${list.uri}`
        return (
          <Menu.Item
            key={list.uri}
            label={l`Allow users in ${list.name} to reply`}
            disabled={!canToggle(value)}
            onPress={e => toggle(e, value)}>
            <UserAvatar size={24} type="list" avatar={list.avatar} />
            <Menu.ItemText>{list.name}</Menu.ItemText>
            <MenuCheck selected={isChecked(value)} />
          </Menu.Item>
        )
      })}
      {unlisted.map(uri => {
        const value: ReplyValue = `list:${uri}`
        const name = createdLists[uri] ?? l`List`
        return (
          <Menu.Item
            key={uri}
            label={l`Allow users in ${name} to reply`}
            disabled={disabled}
            onPress={e => toggle(e, value)}>
            <UserAvatar size={24} type="list" />
            <Menu.ItemText>{name}</Menu.ItemText>
            <MenuCheck selected />
          </Menu.Item>
        )
      })}
      {disabled ? null : (
        <Menu.Item
          testID="composerNewReplyList"
          label={l`New reply list…`}
          onPress={onNewList}>
          <Menu.ItemText>
            <Trans>New reply list…</Trans>
          </Menu.ItemText>
          <Menu.ItemIcon icon={ListPlusIcon} position="right" />
        </Menu.Item>
      )}
    </Menu.Group>
  )
}

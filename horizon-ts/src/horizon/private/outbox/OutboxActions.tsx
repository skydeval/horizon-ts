/*
 * An outbox entry's status and buttons (2K design 8.4's table), drawn on the
 * failed post itself (`PendingPostStatus`) and in Unsent (`UnsentList`).
 * Every button takes the entry's run lock and re-reads its record first
 * (`outbox.ts`); Discard, Delete what was posted and Remove from this device
 * ask first.
 */

import {View} from 'react-native'
import {useLingui} from '@lingui/react/macro'

import {useOpenComposer} from '#/lib/hooks/useOpenComposer'
import {atoms as a, useTheme} from '#/alf'
import {Button, ButtonText} from '#/components/Button'
import * as Prompt from '#/components/Prompt'
import {Text} from '#/components/Typography'
import {privateRouteNote} from '#/horizon/private/composer/blockers'
import {
  beginOutboxEdit,
  checkOutboxEntry,
  deletePostedOutboxEntry,
  discardOutboxEntry,
  type OutboxSeen,
  type OutboxView,
  removeOutboxEntryFromDevice,
  retryOutboxEntry,
} from '#/horizon/private/outbox'
import {useWriteRoute} from '#/horizon/routing/write-route'
import {outboxEntryActions} from './actions'

function seenOf(view: OutboxView): OutboxSeen {
  const {id, did, state, failure, present, deleting} = view.record
  return {id, did, state, failure, present, deleting}
}

/**
 * The entry's status lines and buttons.
 */
export function OutboxActions({
  view,
  inUnsent = false,
  size = 'small',
  beforeCompose = open => open(),
}: {
  view: OutboxView
  inUnsent?: boolean
  size?: 'tiny' | 'small'
  /** Runs `open` once whatever covers the composer is closed (a dialog). */
  beforeCompose?: (open: () => void) => void
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const routes = useWriteRoute()
  const {openComposer} = useOpenComposer()
  const discardControl = Prompt.usePromptControl()
  const deletePostedControl = Prompt.usePromptControl()
  const removeControl = Prompt.usePromptControl()
  const actions = outboxEntryActions(view, routes, {inUnsent})
  const seen = seenOf(view)

  const onEdit = async () => {
    const staged = await beginOutboxEdit(seen)
    if (!staged) return
    beforeCompose(() => openComposer({replyTo: staged.replyTo}))
  }

  return (
    <View style={[a.gap_xs]}>
      <Text style={[a.text_sm, a.font_semi_bold, t.atoms.text]}>
        {actions.label}
      </Text>
      {actions.detail ? (
        <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
          {actions.detail}
        </Text>
      ) : null}
      {actions.note ? (
        <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
          {actions.note}
        </Text>
      ) : null}
      {actions.retry?.disabled ? (
        <Text style={[a.text_sm, t.atoms.text_contrast_medium]}>
          {privateRouteNote(routes)}
        </Text>
      ) : null}
      <View style={[a.flex_row, a.flex_wrap, a.gap_sm, a.pt_2xs]}>
        {actions.retry ? (
          <Button
            testID="outboxRetryButton"
            label={actions.retry.finish ? l`Finish posting` : l`Retry`}
            size={size}
            color="primary"
            disabled={actions.retry.disabled}
            onPress={() => void retryOutboxEntry(seen)}>
            <ButtonText>
              {actions.retry.finish ? l`Finish posting` : l`Retry`}
            </ButtonText>
          </Button>
        ) : null}
        {actions.checkNow ? (
          <Button
            testID="outboxCheckButton"
            label={l`Check now`}
            size={size}
            color="secondary"
            onPress={() => void checkOutboxEntry(seen)}>
            <ButtonText>{l`Check now`}</ButtonText>
          </Button>
        ) : null}
        {actions.edit ? (
          <Button
            testID="outboxEditButton"
            label={l`Edit`}
            size={size}
            color="secondary"
            onPress={() => void onEdit()}>
            <ButtonText>{l`Edit`}</ButtonText>
          </Button>
        ) : null}
        {actions.deletePosted ? (
          <Button
            testID="outboxDeletePostedButton"
            label={l`Delete what was posted`}
            size={size}
            color="negative_subtle"
            onPress={() => deletePostedControl.open()}>
            <ButtonText>{l`Delete what was posted`}</ButtonText>
          </Button>
        ) : null}
        {actions.discard ? (
          <Button
            testID="outboxDiscardButton"
            label={l`Discard`}
            size={size}
            color="negative_subtle"
            onPress={() => discardControl.open()}>
            <ButtonText>{l`Discard`}</ButtonText>
          </Button>
        ) : null}
        {actions.remove ? (
          <Button
            testID="outboxRemoveButton"
            label={l`Remove from this device`}
            size={size}
            color="secondary"
            onPress={() => removeControl.open()}>
            <ButtonText>{l`Remove from this device`}</ButtonText>
          </Button>
        ) : null}
      </View>
      <Prompt.Basic
        control={discardControl}
        title={l`Discard this post?`}
        description={l`Anything of it that was posted will be deleted, and it will be removed from this device.`}
        confirmButtonCta={l`Discard`}
        confirmButtonColor="negative"
        onConfirm={() => void discardOutboxEntry(seen)}
      />
      <Prompt.Basic
        control={deletePostedControl}
        title={l`Delete what was posted?`}
        description={l`Delete the posts that were posted? The text stays on this device in Unsent.`}
        confirmButtonCta={l`Delete`}
        confirmButtonColor="negative"
        onConfirm={() => void deletePostedOutboxEntry(seen)}
      />
      <Prompt.Basic
        control={removeControl}
        title={l`Remove from this device?`}
        description={l`Remove this post from this device? Nothing on your server is deleted: any parts that were posted stay posted, and any reply or quote settings saved for it stay.`}
        confirmButtonCta={l`Remove`}
        confirmButtonColor="negative"
        onConfirm={() => void removeOutboxEntryFromDevice(seen)}
      />
    </View>
  )
}

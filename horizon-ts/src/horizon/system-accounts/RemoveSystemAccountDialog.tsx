/*
 * The remove confirm (system accounts design 4.5, SQ-8) and the registered
 * account's leave confirm (5.4.1). Each traps focus as a prompt does, and
 * puts "Cancel", the safe choice, first, so it takes the first focus.
 */

import {Trans, useLingui} from '@lingui/react/macro'

import {Button, ButtonText} from '#/components/Button'
import {type DialogControlProps, useDialogContext} from '#/components/Dialog'
import * as Prompt from '#/components/Prompt'

function ConfirmButtons({
  cta,
  label,
  testID,
  onConfirm,
}: {
  cta: string
  label: string
  testID: string
  onConfirm: () => void
}) {
  const {t: l} = useLingui()
  const {close} = useDialogContext()
  return (
    <Prompt.Actions>
      <Button
        testID={`${testID}Cancel`}
        label={l`Cancel`}
        color="secondary"
        size="large"
        onPress={() => close()}>
        <ButtonText>
          <Trans>Cancel</Trans>
        </ButtonText>
      </Button>
      <Button
        testID={testID}
        label={label}
        color="negative"
        size="large"
        onPress={() => close(onConfirm)}>
        <ButtonText>{cta}</ButtonText>
      </Button>
    </Prompt.Actions>
  )
}

export function RemoveSystemAccountDialog({
  control,
  lala,
  current,
  onConfirm,
}: {
  control: DialogControlProps
  /** "@lala". */
  lala: string
  /** "@a", the current account. */
  current: string
  onConfirm: () => void
}) {
  const {t: l} = useLingui()
  return (
    <Prompt.Outer control={control} testID="systemAccountsRemovePrompt">
      <Prompt.Content>
        <Prompt.TitleText>
          <Trans>Remove {lala} from your system accounts?</Trans>
        </Prompt.TitleText>
        <Prompt.DescriptionText>
          <Trans>
            You won’t be able to post or act as {lala} from {current}. This
            signs {lala} out of Posting as on this device. Your other devices do
            the same the next time they open Horizon.
          </Trans>
        </Prompt.DescriptionText>
        <Prompt.DescriptionText>
          <Trans>
            To sign {lala} out everywhere now, remove Horizon from {lala}’s
            connected apps at its server.
          </Trans>
        </Prompt.DescriptionText>
      </Prompt.Content>
      <ConfirmButtons
        cta={l`Remove`}
        label={l`Remove ${lala} from system accounts`}
        testID="systemAccountsRemoveConfirm"
        onConfirm={onConfirm}
      />
    </Prompt.Outer>
  )
}

export function LeaveEverySystemDialog({
  control,
  lala,
  onConfirm,
}: {
  control: DialogControlProps
  lala: string
  onConfirm: () => void
}) {
  const {t: l} = useLingui()
  return (
    <Prompt.Outer control={control} testID="systemAccountsLeavePrompt">
      <Prompt.Content>
        <Prompt.TitleText>
          <Trans>
            Remove {lala} from every system account list in Horizon?
          </Trans>
        </Prompt.TitleText>
        <Prompt.DescriptionText>
          <Trans>
            Anyone who already has {lala}’s sign-in can still use it. To stop
            that, change {lala}’s password or remove Horizon from {lala}’s
            connected apps at its server.
          </Trans>
        </Prompt.DescriptionText>
      </Prompt.Content>
      <ConfirmButtons
        cta={l`Remove from every list`}
        label={l`Remove ${lala} from every system account list`}
        testID="systemAccountsLeaveConfirm"
        onConfirm={onConfirm}
      />
    </Prompt.Outer>
  )
}

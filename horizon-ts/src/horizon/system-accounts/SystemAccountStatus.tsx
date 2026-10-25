/*
 * The registered account's own view (system accounts design 5.4.1, SA-15):
 * when some list holds the current account, "At least one account can post
 * as @lala in Horizon." and **Leave every system**. Never which accounts,
 * never how many. Whoever holds this account's sign-in owns it, its leave
 * included (SQ-15).
 */

import {useEffect, useState} from 'react'
import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {useSession} from '#/state/session'
import {atoms as a, useTheme} from '#/alf'
import {Button, ButtonText} from '#/components/Button'
import * as Dialog from '#/components/Dialog'
import {Text} from '#/components/Typography'
import {HIT_44} from '#/horizon/identity/edit/fields'
import {announce} from './announce'
import {leaveEverySystem, readRegisteredStatus} from './register'
import {LeaveEverySystemDialog} from './RemoveSystemAccountDialog'
import {accountName, AlertMessage} from './ui'

export function SystemAccountStatus({
  did,
  served,
}: {
  did: string
  served: boolean
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const {currentAccount} = useSession()
  const [registered, setRegistered] = useState<boolean | undefined>()
  const [error, setError] = useState('')
  const control = Dialog.useDialogControl()
  const lala = accountName(currentAccount?.handle, did)

  useEffect(() => {
    if (!served) return
    let live = true
    void readRegisteredStatus().then(value => {
      if (live) setRegistered(value)
    })
    return () => {
      live = false
    }
  }, [did, served])

  if (!registered) return null

  const onLeave = async () => {
    setError('')
    if (await leaveEverySystem()) {
      setRegistered(false)
      announce(l`${lala} was removed from every system account list.`)
    } else {
      setError(l`Couldn’t remove ${lala} from the lists. Try again.`)
    }
  }

  return (
    <View style={[a.gap_sm, a.pt_md]} testID="systemAccountsStatus">
      <Text style={[a.text_md, a.leading_snug, t.atoms.text_contrast_medium]}>
        <Trans>At least one account can post as {lala} in Horizon.</Trans>
      </Text>
      {error ? <AlertMessage>{error}</AlertMessage> : null}
      <View style={[a.flex_row]}>
        <Button
          testID="systemAccountsLeave"
          label={l`Leave every system`}
          onPress={() => control.open()}
          size="small"
          color="negative_subtle"
          hitSlop={HIT_44}>
          <ButtonText>
            <Trans>Leave every system</Trans>
          </ButtonText>
        </Button>
      </View>
      <LeaveEverySystemDialog
        control={control}
        lala={lala}
        onConfirm={() => void onLeave()}
      />
    </View>
  )
}

/*
 * Account settings, "Private posts" (2K design 8.2). In 2K-9 the dialog holds
 * the Unsent section only (8.4); the rotation status, the copy by route and
 * Rotate now join it in 2K-6.
 */

import {View} from 'react-native'
import {useLingui} from '@lingui/react/macro'

import {atoms as a, web} from '#/alf'
import * as Dialog from '#/components/Dialog'
import {Text} from '#/components/Typography'
import {UnsentList} from '#/horizon/private/outbox/UnsentList'

export function PrivatePostsDialog({
  control,
  did,
}: {
  control: Dialog.DialogControlProps
  did: string
}) {
  return (
    <Dialog.Outer control={control}>
      <Dialog.Handle />
      <PrivatePostsDialogInner control={control} did={did} />
    </Dialog.Outer>
  )
}

function PrivatePostsDialogInner({
  control,
  did,
}: {
  control: Dialog.DialogControlProps
  did: string
}) {
  const {t: l} = useLingui()
  return (
    <Dialog.ScrollableInner
      label={l`Private posts`}
      style={[web({maxWidth: 480}), a.w_full]}>
      <View style={[a.gap_lg]}>
        <Text style={[a.text_2xl, a.font_bold]}>{l`Private posts`}</Text>
        <UnsentList did={did} beforeCompose={open => control.close(open)} />
      </View>
      <Dialog.Close />
    </Dialog.ScrollableInner>
  )
}

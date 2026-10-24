/*
 * The "Posting as" toasts (Phase 5 design 8.4, 8.5).
 */

import {t} from '@lingui/core/macro'
import {Trans} from '@lingui/react/macro'

import * as Toast from '#/components/Toast'
import {setPostingNotifier} from './notify'

// A refused "Posting as" choice shows as a toast once the composer loads this.
setPostingNotifier(message => Toast.show(message, {type: 'warning'}))

/**
 * "Posted. The front couldn't be updated." with Try again (8.4): the post
 * stands either way.
 */
export function showFrontFailedToast(retry: () => void) {
  Toast.show(
    <Toast.Outer>
      <Toast.Icon />
      <Toast.Text>{t`Posted. The front couldn’t be updated.`}</Toast.Text>
      <Toast.Action label={t`Try updating the front again`} onPress={retry}>
        <Trans>Try again</Trans>
      </Toast.Action>
    </Toast.Outer>,
    {type: 'warning'},
  )
}

/**
 * The text of the composer's success toast when the post went from another
 * account (8.5): "Posted as @other".
 */
export function postedAsText(handle: string): string {
  return t`Posted as @${handle}`
}

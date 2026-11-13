/*
 * Web sign-up on bsky.social. bsky.social's sign-up check sends its result
 * to bsky.app, which no other site can read (bsky.app refuses to load in a
 * frame), so a bsky.social account can't be finished from Horizon's web
 * app. On the web, with bsky.social picked, the first sign-up step shows
 * this note and a button to bsky.app in place of the form; afterwards the
 * person signs in to Horizon as usual. Other providers sign up as before.
 */

import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {atoms as a} from '#/alf'
import * as Admonition from '#/components/Admonition'
import {ButtonText} from '#/components/Button'
import {Link} from '#/components/Link'

const BSKY_APP = 'https://bsky.app/'

/** The note and the button to bsky.app. */
export function BskySocialWebNote() {
  const {t: l} = useLingui()
  return (
    <View style={[a.gap_md]}>
      <Admonition.Admonition type="info">
        <Trans>
          New bsky.social accounts can only be created on bsky.app. Create your
          account there, then come back and sign in to Horizon.
        </Trans>
      </Admonition.Admonition>
      <Link
        to={BSKY_APP}
        label={l`Create your account on bsky.app`}
        accessibilityHint={l`Opens bsky.app in a new tab`}
        size="large"
        color="primary">
        <ButtonText>
          <Trans>Create account on bsky.app</Trans>
        </ButtonText>
      </Link>
    </View>
  )
}

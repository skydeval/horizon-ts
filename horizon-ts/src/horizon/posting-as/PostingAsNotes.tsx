/*
 * The composer's "Posting as" notes (Phase 5 design 8.2), shown in the row
 * above the pills, at every width:
 *
 * - a failed read of the posting account: "Couldn't load @other's
 *   settings." with Try again, which runs the failed reads again;
 * - a draft written as an account that is not signed in here: "Written as
 *   @other. Sign in to that account or choose another.";
 * - a restored draft whose reply lists of another account were removed;
 * - system accounts (system accounts design 4.5, 6.4, 8.3): a draft whose
 *   account needs a sign-in here (with the button) or is not on the list,
 *   "Removing @lala..." while a remove runs, and a chosen account the list
 *   dropped.
 */

import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {sanitizeHandle} from '#/lib/strings/handles'
import {atoms as a, useTheme} from '#/alf'
import {Button, ButtonText} from '#/components/Button'
import {Text} from '#/components/Typography'
import {POSTING_AS} from '#/horizon/switches'
import {usePostingState} from './compose-store'
import {requestPostingReverify, retryPostingReads} from './gates'

export function PostingAsNotes() {
  const t = useTheme()
  const {t: l} = useLingui()
  const s = usePostingState()
  if (!POSTING_AS || !s.active) return null
  const handle = s.handle ? `@${sanitizeHandle(s.handle)}` : l`that account`
  const lines: React.ReactNode[] = []
  if (s.hold.kind === 'failed') {
    lines.push(
      <View
        key="failed"
        style={[a.flex_row, a.align_center, a.gap_sm, a.flex_wrap]}>
        <Text
          testID="composerPostingAsFailed"
          style={[a.text_sm, a.leading_snug, {color: t.palette.negative_500}]}>
          {l`Couldn’t load ${handle}’s settings.`}
        </Text>
        <Button
          testID="composerPostingAsRetry"
          label={l`Try loading the settings again`}
          size="tiny"
          color="secondary"
          onPress={() => retryPostingReads()}>
          <ButtonText>
            <Trans>Try again</Trans>
          </ButtonText>
        </Button>
      </View>,
    )
  }
  if (s.hold.kind === 'signedOut') {
    const reason = s.hold.reason
    const did = s.did
    lines.push(
      <View
        key="signed-out"
        style={[a.flex_row, a.align_center, a.gap_sm, a.flex_wrap]}>
        <Text
          testID="composerPostingAsSignedOut"
          style={[a.text_sm, a.leading_snug, {color: t.palette.negative_500}]}>
          {reason === 'signIn'
            ? l`Sign in as ${handle} on this device to post this draft.`
            : reason === 'notListed'
              ? l`${handle} isn’t one of your system accounts. Add it in Edit Profile, or choose another account.`
              : l`Written as ${handle}. Sign in to that account or choose another.`}
        </Text>
        {reason === 'signIn' && did ? (
          <Button
            testID="composerPostingAsDraftSignIn"
            label={l`Sign in as ${handle} on this device`}
            accessibilityHint={l`Opens your server’s sign-in`}
            size="tiny"
            color="secondary"
            onPress={() => requestPostingReverify(did)}>
            <ButtonText>
              <Trans>Sign in</Trans>
            </ButtonText>
          </Button>
        ) : null}
      </View>,
    )
  }
  if (s.removing) {
    lines.push(
      <Text
        key="removing"
        testID="composerPostingAsRemoving"
        role="status"
        style={[a.text_sm, a.leading_snug, t.atoms.text_contrast_medium]}>
        {l`Removing ${handle}…`}
      </Text>,
    )
  }
  if (s.droppedHandle) {
    lines.push(
      <Text
        key="dropped"
        testID="composerPostingAsDropped"
        style={[a.text_sm, a.leading_snug, t.atoms.text_contrast_medium]}>
        {l`@${sanitizeHandle(s.droppedHandle)} is no longer one of your system accounts.`}
      </Text>,
    )
  }
  if (s.draftNote) {
    lines.push(
      <Text
        key="draft-lists"
        testID="composerPostingAsDraftNote"
        style={[a.text_sm, a.leading_snug, t.atoms.text_contrast_medium]}>
        {s.draftNote === 'foreign-lists-nobody'
          ? l`Reply settings changed: a list from another account was removed. Nobody can reply.`
          : l`Reply settings changed: a list from another account was removed.`}
      </Text>,
    )
  }
  if (lines.length === 0) return null
  return <View style={[a.px_md, a.pb_xs, a.gap_2xs]}>{lines}</View>
}

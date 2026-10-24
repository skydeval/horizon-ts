/*
 * The menu-off path's held stand-in (Phase 5 design 8.2, P5R5-N2, PA-12):
 * while a reset is pending, the composer renders this in place of the stock
 * `ThreadgateBtn`, which takes no `disabled` prop. The stock pill's shape (a
 * small secondary button with its label and chevron), drawn disabled, with a
 * spinner in place of the icon, so nothing chosen in the gap is overwritten
 * when the posting account's settings land.
 */

import {ActivityIndicator} from 'react-native'
import {useLingui} from '@lingui/react/macro'

import {type ThreadgateAllowUISetting} from '#/state/queries/threadgate/types'
import {Button, ButtonIcon, ButtonText} from '#/components/Button'
import {TinyChevronBottom_Stroke2_Corner0_Rounded as TinyChevronIcon} from '#/components/icons/Chevron'
import {interactionSummary} from '#/horizon/private/composer/interaction'
import {type app} from '#/lexicons'

export function HeldInteractionPill({
  threadgate,
  postgate,
}: {
  threadgate: ThreadgateAllowUISetting[]
  postgate: app.bsky.feed.postgate.Main
}) {
  const {t: l} = useLingui()
  const label =
    interactionSummary(threadgate, postgate) === 'anyone'
      ? l`Anyone can interact`
      : l`Interaction limited`
  return (
    <Button
      testID="heldInteractionPill"
      color="secondary"
      size="small"
      disabled
      label={label}
      accessibilityHint={l`Loading the settings of the account this post is from`}
      onPress={() => {}}>
      <ActivityIndicator size="small" />
      <ButtonText numberOfLines={1} maxFontSizeMultiplier={2}>
        {label}
      </ButtonText>
      <ButtonIcon icon={TinyChevronIcon} size="2xs" />
    </Button>
  )
}

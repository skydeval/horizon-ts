import {View} from 'react-native'
import {useLingui} from '@lingui/react/macro'

import {atoms as a, useTheme} from '#/alf'
import {Lock_Stroke2_Corner0_Rounded as LockIcon} from '#/components/icons/Lock'
import {isPrivateDraft} from '#/horizon/private/composer/drafts'

/**
 * Width of the stock draft item's menu button, which sits at its top right.
 */
const MENU_BUTTON_SIZE = 20

/**
 * The lock on a draft saved Private, in the drafts list (v2 round 2, fix 3):
 * at the item's top right, just left of the stock menu button and level with
 * it, in the timestamp's colour. Positioned absolutely like the stock
 * timestamp and menu button, so the stock layout does not move. Nothing for
 * a public draft.
 */
export function PrivateDraftLock({draftId}: {draftId: string}) {
  const t = useTheme()
  const {t: l} = useLingui()
  if (!isPrivateDraft(draftId)) return null
  return (
    <View
      testID="privateDraftLock"
      accessible
      accessibilityLabel={l`Private draft`}
      accessibilityHint={l`This draft was saved as a private post`}
      pointerEvents="none"
      style={[
        a.absolute,
        a.justify_center,
        a.pointer_events_none,
        {
          top: a.pt_md.paddingTop,
          right: a.pr_md.paddingRight + MENU_BUTTON_SIZE + a.gap_sm.gap,
          height: MENU_BUTTON_SIZE,
        },
      ]}>
      <LockIcon width={14} style={[t.atoms.text_contrast_medium]} />
    </View>
  )
}

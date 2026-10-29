/*
 * The Moderation screen's "Bluesky's moderation" switch (skydeval,
 * 2026-10-29): an adult can turn Bluesky's moderation labeler off; for
 * anyone else it stays on, locked, and says why. Signed out: nothing.
 */

import {View} from 'react-native'
import {Trans, useLingui} from '@lingui/react/macro'

import {atoms as a, useTheme, type ViewStyleProp} from '#/alf'
import * as Toggle from '#/components/forms/Toggle'
import {InlineLinkText} from '#/components/Link'
import {Text} from '#/components/Typography'
import {useBskyModeration} from '#/horizon/bsky-moderation'

export function BskyModerationSwitch({style}: ViewStyleProp) {
  const t = useTheme()
  const {t: l} = useLingui()
  const {available, on, lock, setOn} = useBskyModeration()
  if (!available) return null
  const locked = lock !== null

  return (
    <View
      style={[
        a.w_full,
        a.rounded_md,
        a.overflow_hidden,
        t.atoms.bg_contrast_25,
        style,
      ]}>
      <View
        style={[
          a.py_lg,
          a.px_lg,
          a.flex_row,
          a.align_center,
          a.justify_between,
          a.gap_md,
          locked && {opacity: 0.5},
        ]}>
        <Text
          style={[a.flex_1, a.font_semi_bold, t.atoms.text_contrast_high]}>
          <Trans>Use Bluesky’s moderation</Trans>
        </Text>
        <Toggle.Item
          label={l`Use Bluesky’s moderation labels`}
          disabled={locked}
          name="bskyModeration"
          value={on}
          onChange={(selected: boolean) => setOn(selected)}>
          <View style={[a.flex_row, a.align_center, a.gap_sm]}>
            <Text style={[t.atoms.text_contrast_medium]}>
              {on ? <Trans>On</Trans> : <Trans>Off</Trans>}
            </Text>
            <Toggle.Switch />
          </View>
        </Toggle.Item>
      </View>
      <View style={[a.pb_lg, a.px_lg, a.gap_sm]}>
        <Text style={[a.leading_snug, t.atoms.text_contrast_medium]}>
          <Trans>
            Bluesky’s moderation service labels and hides posts and accounts
            across the network. Turning it off stops its labels in Horizon for
            this account on this device. Posts Bluesky has taken down, and
            legal blocks where you live, still apply.
          </Trans>
        </Text>
        {lock === 'underAge' || lock === 'ageCheck' ? (
          <Text style={[a.leading_snug, t.atoms.text_contrast_medium]}>
            <Trans>Only adults can turn it off.</Trans>
          </Text>
        ) : lock === 'noAge' ? (
          <Text style={[a.leading_snug, t.atoms.text_contrast_medium]}>
            <Trans>
              Only adults can turn it off. Add your birthdate in{' '}
              <InlineLinkText
                label={l`Go to account settings`}
                to="/settings/account">
                account settings
              </InlineLinkText>{' '}
              to change it.
            </Trans>
          </Text>
        ) : null}
      </View>
    </View>
  )
}

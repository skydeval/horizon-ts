import {View} from 'react-native'
import {useLingui} from '@lingui/react/macro'

import {useHaptics} from '#/lib/haptics'
import {atoms as a, tokens, useTheme} from '#/alf'
import {Pressable} from '#/components/Pressable'
import {Text} from '#/components/Typography'

/**
 * One tab of a {@link FolderTabs} pair. `badge` is an unread count drawn
 * after the label (2H design 10.5); empty or absent draws none.
 */
export type FolderTab<K extends string> = {
  key: K
  label: string
  badge?: string
}

/**
 * Two tabs drawn like the tabs of a paper folder (9.1): the selected one
 * raised and joined to the content below, the other set back. Used for the
 * Public | Private switch on Notifications and Saved.
 */
export function FolderTabs<K extends string>({
  tabs,
  selected,
  onSelect,
  onReselect,
  testID,
}: {
  tabs: FolderTab<K>[]
  selected: K
  onSelect: (key: K) => void
  /**
   * Pressing the tab already selected, e.g. to scroll its list to the top
   * and refresh it, as re-pressing a stock tab does.
   */
  onReselect?: (key: K) => void
  testID?: string
}) {
  const t = useTheme()
  const {t: l} = useLingui()
  const haptics = useHaptics()
  return (
    <View
      testID={testID}
      accessibilityRole="tablist"
      style={[
        a.flex_row,
        a.align_end,
        a.gap_2xs,
        a.px_md,
        a.pt_sm,
        a.border_b,
        t.atoms.border_contrast_low,
      ]}>
      {tabs.map(tab => {
        const isSelected = tab.key === selected
        const badge = tab.badge || undefined
        return (
          <Pressable
            key={tab.key}
            testID={testID ? `${testID}-${tab.key}` : undefined}
            accessibilityRole="tab"
            accessibilityState={{selected: isSelected}}
            accessibilityLabel={
              badge ? l`${tab.label}, ${badge} unread` : tab.label
            }
            accessibilityHint=""
            onPress={() => {
              if (isSelected) {
                onReselect?.(tab.key)
                return
              }
              haptics.selection()
              onSelect(tab.key)
            }}
            style={({hovered}) => [
              a.px_lg,
              a.border_t,
              a.border_l,
              a.border_r,
              t.atoms.border_contrast_low,
              {
                borderTopLeftRadius: tokens.borderRadius.md,
                borderTopRightRadius: tokens.borderRadius.md,
              },
              isSelected
                ? [
                    a.pt_md,
                    a.pb_sm,
                    t.atoms.bg,
                    {
                      marginBottom: -1,
                      borderBottomWidth: 1,
                      borderBottomColor: t.atoms.bg.backgroundColor,
                    },
                  ]
                : [
                    a.pt_sm,
                    a.pb_sm,
                    hovered ? t.atoms.bg_contrast_50 : t.atoms.bg_contrast_25,
                  ],
            ]}>
            <View style={[a.flex_row, a.align_center, a.gap_xs]}>
              <Text
                style={[
                  a.text_sm,
                  a.leading_tight,
                  isSelected
                    ? [a.font_semi_bold, t.atoms.text]
                    : [a.font_medium, t.atoms.text_contrast_medium],
                ]}>
                {tab.label}
              </Text>
              {badge && (
                <View
                  style={[
                    a.align_center,
                    a.rounded_full,
                    a.px_xs,
                    {minWidth: 16, backgroundColor: t.palette.primary_500},
                  ]}>
                  <Text
                    style={[
                      a.text_xs,
                      a.font_bold,
                      a.leading_snug,
                      {color: t.palette.white},
                    ]}>
                    {badge}
                  </Text>
                </View>
              )}
            </View>
          </Pressable>
        )
      })}
    </View>
  )
}

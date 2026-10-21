/*
 * Applies the signed-in account's saved theme settings (change list 2,
 * item 11): colour mode, dark theme, font and font size, through the stock
 * setters, so the stock settings stay the one place they live and the
 * values the device keeps signed out. The tree below the session is keyed
 * on the account, so this mounts again on every account switch and
 * applies that account's values at once (from the device's copy of its
 * record, then again when a fresh read changes them). A value the account
 * never saved changes nothing, and with the opt-out on nothing is applied.
 * Rendered by `AppearanceSync`.
 */

import {useEffect} from 'react'

import {useSession} from '#/state/session'
import {useSetThemePrefs, useThemePrefs} from '#/state/shell'
import {useAlf} from '#/alf'
import {accountThemePrefs, useAppearanceState} from '#/horizon/appearance/store'
import {themeChanges} from '#/horizon/appearance/theme-prefs'

/** Renders nothing. */
export function ThemePrefsSync() {
  const {currentAccount} = useSession()
  const saved = accountThemePrefs(useAppearanceState(), currentAccount?.did)
  const {colorMode, darkTheme} = useThemePrefs()
  const {setColorMode, setDarkTheme} = useSetThemePrefs()
  const {fonts} = useAlf()

  const changes = themeChanges(saved, {
    colorMode,
    darkTheme,
    font: fonts.family,
    fontScale: fonts.scale,
  })
  const {colorMode: nextMode, darkTheme: nextDark} = changes
  const {font: nextFont, fontScale: nextScale} = changes

  useEffect(() => {
    if (nextMode) setColorMode(nextMode)
    if (nextDark) setDarkTheme(nextDark)
  }, [nextMode, nextDark, setColorMode, setDarkTheme])

  useEffect(() => {
    if (nextFont) fonts.setFontFamily(nextFont)
    if (nextScale) fonts.setFontScale(nextScale)
  }, [nextFont, nextScale, fonts])

  return null
}

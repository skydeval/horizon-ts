/*
 * The account's theme settings against the stock device ones (change list
 * 2, item 11), as pure functions: which stock setter to call for an
 * account's saved values, and the record value of a stock Font size.
 */

import {
  type ColorModePref,
  type DarkThemePref,
  type FontPref,
  type FontSizePref,
  type ThemePrefs,
} from '#/horizon/appearance/model'

/** The stock Font size values (`Device['fontScale']`). */
export type FontScale = '-2' | '-1' | '0' | '1' | '2'

/** The stock settings as the device has them now. */
export type DeviceThemeSettings = {
  colorMode: ColorModePref
  darkTheme: DarkThemePref | undefined
  font: FontPref
  fontScale: FontScale
}

/** A stock Font size as the record names it. */
export function fontSizeOfScale(scale: FontScale): FontSizePref {
  if (scale === '-1' || scale === '-2') return 'smaller'
  if (scale === '1' || scale === '2') return 'larger'
  return 'default'
}

/** The stock Font size for the record's name. */
export function scaleOfFontSize(size: FontSizePref): FontScale {
  if (size === 'smaller') return '-1'
  if (size === 'larger') return '1'
  return '0'
}

/** The stock settings to change so the device shows the account's values. */
export type ThemeChanges = {
  colorMode?: ColorModePref
  darkTheme?: DarkThemePref
  font?: FontPref
  fontScale?: FontScale
}

/**
 * What to set: each saved value that differs from the device's; nothing for
 * a value the account never saved, so the device keeps its own.
 */
export function themeChanges(
  saved: ThemePrefs,
  device: DeviceThemeSettings,
): ThemeChanges {
  const out: ThemeChanges = {}
  if (saved.colorMode && saved.colorMode !== device.colorMode) {
    out.colorMode = saved.colorMode
  }
  if (saved.darkTheme && saved.darkTheme !== (device.darkTheme ?? 'dim')) {
    out.darkTheme = saved.darkTheme
  }
  if (saved.font && saved.font !== device.font) out.font = saved.font
  if (saved.fontSize && saved.fontSize !== fontSizeOfScale(device.fontScale)) {
    out.fontScale = scaleOfFontSize(saved.fontSize)
  }
  return out
}

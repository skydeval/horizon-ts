/*
 * Small shared pieces of the system accounts' UI (system accounts design
 * 4.6): an error read as an alert, a status line read politely, and how an
 * account is named in text.
 */

import {View} from 'react-native'

import {sanitizeHandle} from '#/lib/strings/handles'
import {atoms as a, useTheme} from '#/alf'
import {Admonition} from '#/components/Admonition'
import {Text} from '#/components/Typography'

/** "@lala", or the DID when no handle is known. */
export function accountName(handle: string | undefined, did: string): string {
  return handle ? sanitizeHandle(handle, '@') : did
}

/** An error next to its control, read as an alert (4.6 "Errors"). */
export function AlertMessage({
  children,
  testID,
}: {
  children: string
  testID?: string
}) {
  return (
    <View
      testID={testID}
      role="alert"
      aria-live="assertive"
      accessibilityLiveRegion="assertive">
      <Admonition type="error">{children}</Admonition>
    </View>
  )
}

/** A line read politely when it changes (`role="status"`). */
export function StatusMessageText({
  children,
  testID,
}: {
  children: string
  testID?: string
}) {
  const t = useTheme()
  return (
    <Text
      testID={testID}
      role="status"
      aria-live="polite"
      accessibilityLiveRegion="polite"
      style={[a.text_sm, a.leading_snug, t.atoms.text_contrast_medium]}>
      {children}
    </Text>
  )
}

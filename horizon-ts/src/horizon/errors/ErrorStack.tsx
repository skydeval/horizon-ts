/*
 * The crash's stack under the "Oh no!" screen, for test builds
 * (SHOW_ERROR_STACK): the JS stack and the component stack, selectable so a
 * tester can copy it. In a release build the frames are bundle offsets, which
 * the build's source map turns back into files and lines.
 */

import {Platform, View} from 'react-native'

import {atoms as a, useTheme} from '#/alf'
import {Text} from '#/components/Typography'
import {describeCrash} from '#/horizon/errors/crash-text'

export function ErrorStack({
  error,
  componentStack,
}: {
  error: unknown
  componentStack?: string
}) {
  const t = useTheme()
  return (
    <View style={[a.px_xl, a.pb_2xl]}>
      <Text
        selectable
        style={[
          a.text_xs,
          t.atoms.text_contrast_medium,
          {fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace'},
        ]}>
        {describeCrash(error, componentStack)}
      </Text>
    </View>
  )
}

import type * as ReactNative from 'react-native'
import {describe, expect, it, jest} from '@jest/globals'
import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {render as rtlRender} from '@testing-library/react-native'

import type * as ThemesModule from '#/alf/themes'
import {MediaSpoilerCover} from '#/horizon/media-spoilers/MediaSpoilerCover'
import {NoThumbnailTile} from '#/horizon/video/NoThumbnailTile'

jest.mock('#/lib/haptics', () => ({
  useHaptics: () => ({tap: () => {}}),
}))
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  useTheme: () =>
    jest.requireActual<typeof ThemesModule>('#/alf/themes').themes.light,
  web: (value: unknown) => value,
}))
jest.mock('#/components/Typography', () => ({
  Text: jest.requireActual<typeof ReactNative>('react-native').Text,
}))
jest.mock('#/components/video/PlayButtonIcon', () => ({
  PlayButtonIcon: () => {
    const {View} = jest.requireActual<typeof ReactNative>('react-native')
    return <View testID="playIcon" />
  },
}))
jest.mock('expo-image', () => ({
  Image: () => {
    const {View} = jest.requireActual<typeof ReactNative>('react-native')
    return <View testID="expoImage" />
  },
}))

i18n.loadAndActivate({locale: 'en', messages: {}})

function render(ui: React.ReactElement) {
  return rtlRender(<I18nProvider i18n={i18n}>{ui}</I18nProvider>)
}

describe('a video without a thumbnail (a private one, from its PDS)', () => {
  it('a card draws a neutral tile with the play icon, and no image', () => {
    const view = render(<NoThumbnailTile />)
    expect(view.getByTestId('videoNoThumbnailTile')).toBeTruthy()
    expect(view.getByTestId('playIcon')).toBeTruthy()
    expect(view.queryByTestId('expoImage')).toBeNull()
  })

  it('a card with the spoiler pill draws the tile without the play icon', () => {
    const view = render(<NoThumbnailTile showPlay={false} />)
    expect(view.getByTestId('videoNoThumbnailTile')).toBeTruthy()
    expect(view.queryByTestId('playIcon')).toBeNull()
  })

  it('the spoiler cover is a plain tinted cover with the pill, and no image', () => {
    const view = render(
      <MediaSpoilerCover
        thumb={undefined}
        contentWarning={false}
        label="Reveal video"
        hint=""
        onReveal={() => {}}
      />,
    )
    expect(view.queryByTestId('expoImage')).toBeNull()
    expect(view.getByText('Spoiler')).toBeTruthy()
    expect(view.getByLabelText('Reveal video')).toBeTruthy()
  })

  it('the spoiler cover blurs the thumbnail when there is one', () => {
    const view = render(
      <MediaSpoilerCover
        thumb="https://cdn.example/thumb.jpg"
        contentWarning={false}
        label="Reveal video"
        hint=""
        onReveal={() => {}}
      />,
    )
    expect(view.getByTestId('expoImage')).toBeTruthy()
  })
})

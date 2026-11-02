import type * as ReactNative from 'react-native'
import {describe, expect, it, jest} from '@jest/globals'
import {i18n} from '@lingui/core'
import {I18nProvider} from '@lingui/react'
import {render} from '@testing-library/react-native'

import type * as ThemesModule from '#/alf/themes'
import {PatchNotesScreen} from '#/horizon/patch-notes/PatchNotesScreen'

jest.mock('#/horizon/patch-notes/notes.generated', () => ({
  PATCH_NOTES: [
    {
      version: '0.1.15',
      build: 15,
      date: '2026-11-02',
      summary: 'Newest summary.',
      sections: [{kind: 'fixes', items: ['Newest fix.']}],
    },
    {
      version: '0.1.14',
      build: 14,
      date: '2026-11-01',
      summary: 'Older summary.',
      sections: [{kind: 'fixes', items: ['Older fix.']}],
    },
  ],
}))
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  useTheme: () =>
    jest.requireActual<typeof ThemesModule>('#/alf/themes').themes.light,
}))
jest.mock('#/components/Typography', () => {
  const {Text} = jest.requireActual<typeof ReactNative>('react-native')
  return {Text, H2: Text, H3: Text}
})
jest.mock('#/components/Layout', () => {
  const {View} = jest.requireActual<typeof ReactNative>('react-native')
  // Lower case, so the React Compiler leaves the mock factory alone
  const pass = ({children}: {children?: React.ReactNode}) => (
    <View>{children}</View>
  )
  const none = () => null
  return {
    Screen: pass,
    Content: pass,
    Header: {
      Outer: pass,
      BackButton: none,
      Content: pass,
      TitleText: pass,
      Slot: none,
    },
  }
})

i18n.loadAndActivate({locale: 'en', messages: {}})

describe('PatchNotesScreen', () => {
  it('shows only the newest release', () => {
    const view = render(
      <I18nProvider i18n={i18n}>
        <PatchNotesScreen {...({} as React.ComponentProps<typeof PatchNotesScreen>)} />
      </I18nProvider>,
    )
    expect(view.queryByText('Newest summary.')).not.toBeNull()
    expect(view.queryByText('Newest fix.')).not.toBeNull()
    expect(view.queryByText('Older summary.')).toBeNull()
    expect(view.queryByText('Older fix.')).toBeNull()
  })
})

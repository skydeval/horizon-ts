import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'
import {act, fireEvent, render} from '@testing-library/react-native'

import {LinkFormDialog} from '#/features/profileLinks/components/LinkFormDialog'
import {LINK_META_DEBOUNCE_MS} from '#/horizon/profile-links/payment-domains'

/*
 * The link editor with its network edges replaced by fixtures: cardyb's
 * extract (`getLinkMeta`), the favicon upload and Safelink. Nothing here
 * reaches the network.
 */
const mockGetLinkMeta = jest.fn(
  (_url: string, _timeout?: number) =>
    Promise.resolve({url: _url, title: 'Page Title | Site'}) as Promise<{
      url: string
      title?: string
      error?: string
    }>,
)
const mockUploadLinkIcon = jest.fn((_url: string) => Promise.resolve(undefined))
const mockCheckSafelink = jest.fn((_url: string) => Promise.resolve('none'))

jest.mock('#/lib/link-meta/link-meta', () => ({
  getLinkMeta: (url: string, timeout?: number) => mockGetLinkMeta(url, timeout),
}))
jest.mock('#/features/profileLinks/state', () => ({
  useUploadLinkIcon: () => (url: string) => mockUploadLinkIcon(url),
}))
jest.mock('#/features/profileLinks/safelink', () => ({
  checkSafelink: (url: string) => mockCheckSafelink(url),
}))
jest.mock('#/features/profileLinks/palette', () => ({
  useSupportPalette: () => ({tintText: '', bg: '', bgHover: '', fg: ''}),
}))
jest.mock('#/features/profileLinks/components/ProviderLogo', () => ({
  ProviderLogo: () => null,
}))
jest.mock('#/features/profileLinks/components/SupportedSitesDialog', () => ({
  SupportedSitesDialog: () => null,
}))
jest.mock('#/analytics', () => ({useAnalytics: () => ({metric: () => {}})}))
jest.mock('#/env', () => ({IS_LIQUID_GLASS: false}))
jest.mock('@lingui/react', () => ({
  useLingui: () => ({_: (value: {message: string}) => value.message}),
  Trans: ({message}: {message?: string}) => message ?? null,
}))
jest.mock('#/alf', () => ({
  atoms: new Proxy({}, {get: () => ({})}),
  tokens: {space: {xl: 0, _2xl: 0}},
  useTheme: () => ({
    atoms: new Proxy({}, {get: () => ({})}),
    palette: {negative_500: ''},
  }),
  web: () => ({}),
}))
jest.mock('#/components/Dialog', () => {
  const {TextInput} = require('react-native') as typeof import('react-native')
  return {
    Outer: ({children}: {children: React.ReactNode}) => <>{children}</>,
    Handle: () => null,
    ScrollableInner: ({children}: {children: React.ReactNode}) => (
      <>{children}</>
    ),
    Input: TextInput,
    useDialogContext: () => ({close: (cb?: () => void) => cb?.()}),
    useDialogControl: () => ({open: () => {}, close: () => {}}),
  }
})
jest.mock('#/components/forms/TextField', () => {
  const {View} = require('react-native') as typeof import('react-native')
  return {
    LabelText: () => null,
    Root: ({children}: {children: React.ReactNode}) => <View>{children}</View>,
    Icon: () => null,
    SuffixText: () => null,
  }
})
jest.mock('#/components/Button', () => {
  const {Pressable} = require('react-native') as typeof import('react-native')
  return {
    Button: ({
      testID,
      onPress,
      disabled,
    }: {
      testID?: string
      onPress?: () => void
      disabled?: boolean
    }) => (
      <Pressable
        accessibilityRole="button"
        testID={testID}
        onPress={onPress}
        disabled={disabled}
      />
    ),
    ButtonIcon: () => null,
    ButtonText: () => null,
  }
})
jest.mock('#/components/Link', () => ({
  createStaticClick: () => ({}),
  InlineLinkText: () => null,
}))
jest.mock('#/components/Loader', () => ({Loader: () => null}))
jest.mock('#/components/Typography', () => {
  const {Text} = require('react-native') as typeof import('react-native')
  return {Text}
})
jest.mock('#/components/icons/ChainLink', () => ({
  ChainLink_Stroke2_Corner0_Rounded: () => null,
}))
jest.mock('#/components/icons/TimesLarge', () => ({
  TimesLarge_Stroke2_Corner0_Rounded: () => null,
}))

const control = {} as React.ComponentProps<typeof LinkFormDialog>['control']

function setup(
  link: React.ComponentProps<typeof LinkFormDialog>['link'] = null,
) {
  const onSave = jest.fn()
  const view = render(
    <LinkFormDialog
      control={control}
      link={link}
      existingUrls={[]}
      onSave={onSave}
    />,
  )
  const urlInput = view.getByTestId('profileLinkUrlInput')
  const titleInput = () => view.getByTestId('profileLinkTitleInput')
  const type = (value: string) => {
    fireEvent.changeText(urlInput, value)
  }
  /** Types the value one character at a time, as a person would. */
  const typeEach = (value: string) => {
    for (let i = 1; i <= value.length; i++) type(value.slice(0, i))
  }
  const save = async () => {
    await act(() => {
      fireEvent.press(view.getByTestId('profileLinkSaveBtn'))
      return flush()
    })
  }
  return {view, onSave, type, typeEach, titleInput, save}
}

/** Lets pending promise callbacks run. */
function flush() {
  return Promise.resolve()
}

async function settle() {
  await act(() => {
    jest.advanceTimersByTime(LINK_META_DEBOUNCE_MS)
    return flush()
  })
}

beforeEach(() => {
  jest.useFakeTimers()
  mockGetLinkMeta.mockClear()
  mockUploadLinkIcon.mockClear()
  mockCheckSafelink.mockClear()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('profile link editor, payment links (design.md 10.2)', () => {
  it.each([
    'paypal.com/donate/?hosted_button_id=ABC',
    'www.paypal.com/pools/c/abc',
    'paypal.com/ncp/payment/XYZ',
    'paypal.me',
    'paypal.me/name',
    'github.com/sponsors/someone',
    'cash.app/$tag',
  ])('sends %s to no cardyb extract or favicon, typed or saved', async url => {
    const {typeEach, save, onSave} = setup()
    typeEach(url)
    await settle()
    expect(mockGetLinkMeta).not.toHaveBeenCalled()
    await save()
    expect(mockGetLinkMeta).not.toHaveBeenCalled()
    expect(mockUploadLinkIcon).not.toHaveBeenCalled()
    // Safelink is kept: the URL is going into a public record anyway
    expect(mockCheckSafelink).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledTimes(1)
    const saved = onSave.mock.calls[0][0] as {title?: string; icon?: unknown}
    expect(saved.title).toBeUndefined()
    expect(saved.icon).toBeUndefined()
  })

  it('typing a payment prefix calls nothing, even when it pauses', async () => {
    const {type} = setup()
    for (const prefix of [
      'paypal.co',
      'paypal.com',
      'paypal.com/',
      'paypal.me',
    ]) {
      type(prefix)
      await settle()
    }
    expect(mockGetLinkMeta).not.toHaveBeenCalled()
  })

  it('clears an auto-filled title once the URL becomes a payment link', async () => {
    const {type, titleInput} = setup()
    type('example.com')
    await settle()
    expect(mockGetLinkMeta).toHaveBeenCalledTimes(1)
    expect(titleInput().props.value).toBe('Page Title')
    type('paypal.com/donate')
    expect(titleInput().props.value).toBe('')
  })

  it('also clears it when the URL becomes a recognised support link', async () => {
    const {type, titleInput} = setup()
    type('example.com')
    await settle()
    expect(titleInput().props.value).toBe('Page Title')
    type('ko-fi.com/name')
    expect(titleInput().props.value).toBe('')
  })

  it('keeps a title the user typed', async () => {
    const {type, titleInput} = setup()
    type('example.com')
    await settle()
    fireEvent.changeText(titleInput(), 'Tip jar')
    type('paypal.com/donate')
    expect(titleInput().props.value).toBe('Tip jar')
  })

  it('a reply for an earlier page that lands late fills nothing', async () => {
    let resolve: (value: {url: string; title: string}) => void = () => {}
    mockGetLinkMeta.mockImplementationOnce(
      () =>
        new Promise(r => {
          resolve = r
        }),
    )
    const {type, titleInput} = setup()
    type('example.com')
    await settle()
    type('paypal.com/donate')
    await act(() => {
      resolve({url: 'https://example.com/', title: 'Late Title'})
      return flush()
    })
    expect(titleInput().props.value).toBe('')
  })

  it('drops a stored favicon when an existing payment link is edited', async () => {
    const {save, onSave, titleInput} = setup({
      url: 'https://www.paypal.com/donate/?x=1',
      title: 'Old',
      icon: {fake: true} as never,
      iconUrl: 'https://cdn.example/icon.png',
    })
    fireEvent.changeText(titleInput(), 'Tips')
    await save()
    expect(mockUploadLinkIcon).not.toHaveBeenCalled()
    expect(mockGetLinkMeta).not.toHaveBeenCalled()
    expect(mockCheckSafelink).not.toHaveBeenCalled()
    const saved = onSave.mock.calls[0][0] as {
      title?: string
      icon?: unknown
      iconUrl?: string
    }
    expect(saved.title).toBe('Tips')
    expect(saved.icon).toBeUndefined()
    expect(saved.iconUrl).toBeUndefined()
  })
})

describe('profile link editor, other links', () => {
  it('asks cardyb once typing settles, not for every prefix', async () => {
    const {typeEach, titleInput} = setup()
    typeEach('example.com/page')
    act(() => {
      jest.advanceTimersByTime(LINK_META_DEBOUNCE_MS - 1)
    })
    expect(mockGetLinkMeta).not.toHaveBeenCalled()
    await settle()
    expect(mockGetLinkMeta).toHaveBeenCalledTimes(1)
    expect(mockGetLinkMeta.mock.calls[0][0]).toBe('https://example.com/page')
    expect(titleInput().props.value).toBe('Page Title')
  })

  it('still fetches the favicon and checks Safelink on save', async () => {
    const {type, save, onSave} = setup()
    type('example.com')
    await settle()
    await save()
    expect(mockUploadLinkIcon).toHaveBeenCalledWith('https://example.com/')
    expect(mockCheckSafelink).toHaveBeenCalledWith('https://example.com/')
    // reachable from the typing check, so no second extract
    expect(mockGetLinkMeta).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('runs the reachability extract on save when typing never checked', async () => {
    const {type, save} = setup()
    type('example.com')
    await save()
    expect(mockGetLinkMeta).toHaveBeenCalledTimes(1)
    expect(mockUploadLinkIcon).toHaveBeenCalledTimes(1)
  })
})

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * Edit Profile's description state (`useProfileAltEditParts`): each field
 * starts from the description of the image the profile has now, a new or
 * removed image drops its description, the dirty check, and the save after
 * the profile reads the saved image CIDs. A fake PDS; no network call.
 */

jest.unmock('multiformats/cid')
jest.mock('#/state/session/network', () => ({
  networkAwareFetch: () => Promise.reject(new Error('no network in tests')),
}))
jest.mock('#/state/queries/pds-detection', () => ({
  resolvePdsForIdentifier: () => Promise.resolve(undefined),
}))
jest.mock('#/analytics/identifiers', () => ({
  getDeviceId: () => 'device-id-1',
  getSessionId: () => 'session-id-1',
}))

const mockState: {
  account?: string
  writer?: unknown
  answer?: unknown
} = {}

jest.mock('#/state/session', () => ({
  useMaybePdsClient: () => null,
  useSession: () => ({
    currentAccount: mockState.account ? {did: mockState.account} : undefined,
  }),
}))
jest.mock('#/horizon/identity/edit/own', () => ({
  useOwnWriter: () => mockState.writer,
}))
jest.mock('#/horizon/profile-alt/query', () => ({
  ...jest.requireActual('#/horizon/profile-alt/query'),
  useProfileAltQuery: () => ({
    data: mockState.answer,
    isError: false,
    refetch: () => Promise.resolve(),
  }),
}))

import {i18n} from '@lingui/core'
import {QueryClient} from '@tanstack/react-query'
import {act, renderHook} from '@testing-library/react-native'

import {cidOf, createRepo} from '#/horizon/identity/__tests__/write-harness'
import {useProfileAltEditParts} from '#/horizon/profile-alt/edit-parts'
import {parseProfileAlt} from '#/horizon/profile-alt/parse'

i18n.loadAndActivate({locale: 'en', messages: {}})

const DID = 'did:plc:profilealteditaaaaaaaa'
const ALT = 'app.nearhorizon.actor.profileAlt'
const PROFILE = 'app.bsky.actor.profile'
const AVATAR = cidOf(911)
const BANNER = cidOf(912)
const NEW_AVATAR = cidOf(913)

const profile = {
  did: DID,
  avatar: `https://cdn.bsky.app/img/avatar/plain/${DID}/${AVATAR}@jpeg`,
  banner: `https://cdn.bsky.app/img/banner/plain/${DID}/${BANNER}@jpeg`,
}

function blob(cid: string) {
  return {$type: 'blob', ref: {$link: cid}, mimeType: 'image/jpeg', size: 10}
}

let repo: ReturnType<typeof createRepo>
let qc: QueryClient
let recordCid: string

beforeEach(() => {
  repo = createRepo(DID)
  qc = new QueryClient({defaultOptions: {queries: {retry: false}}})
  const value = {
    $type: ALT,
    avatar: {image: AVATAR, alt: 'Fox.'},
    banner: {image: cidOf(999), alt: 'An old banner.'},
    updatedAt: '2026-10-26T12:00:00Z',
  }
  recordCid = repo.seed(ALT, 'self', value)
  mockState.account = DID
  mockState.writer = {did: DID, pdsClient: repo.client, queryClient: qc}
  mockState.answer = {record: parseProfileAlt(value), cid: recordCid}
})

afterEach(() => {
  qc.clear()
})

describe('useProfileAltEditParts', () => {
  it('starts from the description of the image shown, none for a stale one', () => {
    const {result} = renderHook(() => useProfileAltEditParts(profile))
    expect(result.current.enabled).toBe(true)
    expect(result.current.texts).toEqual({avatar: 'Fox.', banner: ''})
    expect(result.current.dirty).toBe(false)
  })

  it('is off for another account', () => {
    mockState.account = 'did:plc:someoneelseaaaaaaaaaaaa'
    const {result} = renderHook(() => useProfileAltEditParts(profile))
    expect(result.current.enabled).toBe(false)
    expect(result.current.dirty).toBe(false)
  })

  it('saves an edit after the profile, for the image now saved', async () => {
    repo.seed(PROFILE, 'self', {
      $type: PROFILE,
      avatar: blob(AVATAR),
      banner: blob(BANNER),
    })
    const {result} = renderHook(() => useProfileAltEditParts(profile))
    act(() => result.current.setText('banner', 'A pine forest.'))
    expect(result.current.dirty).toBe(true)
    await act(() => result.current.save())
    const [put] = repo.writesOf('putRecord')
    expect(put.body.swapRecord).toBe(recordCid)
    expect(put.body.record).toMatchObject({
      avatar: {image: AVATAR, alt: 'Fox.'},
      banner: {image: BANNER, alt: 'A pine forest.'},
    })
  })

  it('drops the description of an image replaced', async () => {
    repo.seed(PROFILE, 'self', {$type: PROFILE, avatar: blob(NEW_AVATAR)})
    const {result} = renderHook(() => useProfileAltEditParts(profile))
    act(() => result.current.imageChanged('avatar'))
    expect(result.current.texts.avatar).toBe('')
    expect(result.current.dirty).toBe(true)
    await act(() => result.current.save())
    // Nothing is left to describe, so the record goes
    expect(repo.writesOf('deleteRecord')).toHaveLength(1)
    expect(repo.get(ALT, 'self')).toBeUndefined()
  })

  it('describes a new image with the text written for it', async () => {
    repo.seed(PROFILE, 'self', {$type: PROFILE, avatar: blob(NEW_AVATAR)})
    const {result} = renderHook(() => useProfileAltEditParts(profile))
    act(() => result.current.setText('avatar', 'Old text, still typed.'))
    act(() => result.current.imageChanged('avatar'))
    expect(result.current.texts.avatar).toBe('')
    act(() => result.current.setText('avatar', 'A new fox.'))
    await act(() => result.current.save())
    const [put] = repo.writesOf('putRecord')
    expect(put.body.record).toMatchObject({
      avatar: {image: NEW_AVATAR, alt: 'A new fox.'},
    })
  })

  it('writes nothing when untouched', async () => {
    const {result} = renderHook(() => useProfileAltEditParts(profile))
    await act(() => result.current.save())
    expect(repo.writes).toHaveLength(0)
  })

  it('holds Save over the limit', () => {
    const {result} = renderHook(() => useProfileAltEditParts(profile))
    act(() => result.current.setText('avatar', 'a'.repeat(2001)))
    expect(result.current.invalid).toBe(true)
  })
})

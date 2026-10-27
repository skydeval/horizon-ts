import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * Profile image descriptions (design `profile-alt-text.md`): parsing the
 * record, matching a slot to the image shown by CID, the label, reading
 * one's own record, and writing it after the profile (unknown keys kept,
 * empty slots left out, a record left empty deleted, swaps). A fake PDS;
 * no network call.
 */

jest.unmock('multiformats/cid')
jest.mock('#/state/session/network', () => ({
  networkAwareFetch: () => Promise.reject(new Error('no network in tests')),
}))
jest.mock('#/state/session', () => ({useMaybePdsClient: () => null}))
jest.mock('#/state/queries/pds-detection', () => ({
  resolvePdsForIdentifier: () => Promise.resolve(undefined),
}))
jest.mock('#/analytics/identifiers', () => ({
  getDeviceId: () => 'device-id-1',
  getSessionId: () => 'session-id-1',
}))

import {i18n} from '@lingui/core'
import {QueryClient} from '@tanstack/react-query'

import {cidOf, createRepo} from '#/horizon/identity/__tests__/write-harness'
import {
  IdentityReadError,
  registerOwnIdentityClient,
  resetIdentityReads,
} from '#/horizon/identity/reads'
import {IdentityWriteConflictError} from '#/horizon/identity/writes'
import {labelWithAlt} from '#/horizon/profile-alt/labels'
import {
  altFits,
  altForImage,
  cidOfImageUrl,
  parseProfileAlt,
} from '#/horizon/profile-alt/parse'
import {
  fetchProfileAlt,
  type ProfileAltAnswer,
  profileAltQueryKey,
} from '#/horizon/profile-alt/query'
import {
  buildProfileAltRecord,
  nextSlots,
  ProfileAltTooLongError,
  type ProfileAltWriter,
  readOwnProfileImageCids,
  sameSlots,
  saveProfileAlt,
} from '#/horizon/profile-alt/write'

i18n.loadAndActivate({locale: 'en', messages: {}})

const DID = 'did:plc:profilealtaaaaaaaaaaaaa'
const ALT = 'app.nearhorizon.actor.profileAlt'
const PROFILE = 'app.bsky.actor.profile'
const AVATAR = cidOf(901)
const BANNER = cidOf(902)
const NEW_AVATAR = cidOf(903)

function cdn(preset: string, cid: string) {
  return `https://cdn.bsky.app/img/${preset}/plain/${DID}/${cid}@jpeg`
}

function blob(cid: string) {
  return {$type: 'blob', ref: {$link: cid}, mimeType: 'image/jpeg', size: 10}
}

describe('parseProfileAlt', () => {
  it('reads both slots and keeps the record as read', () => {
    const raw = {
      $type: ALT,
      avatar: {image: AVATAR, alt: 'A red fox in a green scarf.'},
      banner: {image: BANNER, alt: 'A pine forest at dusk.'},
      updatedAt: '2026-10-26T12:00:00Z',
      somethingNew: 1,
    }
    const parsed = parseProfileAlt(raw)
    expect(parsed?.avatar).toEqual({
      image: AVATAR,
      alt: 'A red fox in a green scarf.',
    })
    expect(parsed?.banner?.alt).toBe('A pine forest at dusk.')
    expect(parsed?.raw).toBe(raw)
  })

  it('drops a broken slot on its own and keeps the other', () => {
    const parsed = parseProfileAlt({
      $type: ALT,
      avatar: {image: AVATAR, alt: ''},
      banner: {image: BANNER, alt: 'Forest.'},
      updatedAt: '2026-10-26T12:00:00Z',
    })
    expect(parsed?.avatar).toBeUndefined()
    expect(parsed?.banner?.alt).toBe('Forest.')
    expect(parseProfileAlt({avatar: {alt: 'no image'}})?.avatar).toBeUndefined()
    expect(
      parseProfileAlt({avatar: {image: AVATAR, alt: ' \n\t '}})?.avatar,
    ).toBeUndefined()
  })

  it('refuses another collection and non-objects', () => {
    expect(parseProfileAlt({$type: 'app.bsky.actor.profile'})).toBeNull()
    expect(parseProfileAlt('text')).toBeNull()
    expect(parseProfileAlt(null)).toBeNull()
  })

  it('holds alt to 2000 graphemes and 20000 bytes', () => {
    expect(altFits('a'.repeat(2000))).toBe(true)
    expect(altFits('a'.repeat(2001))).toBe(false)
    // 2000 graphemes of 11 bytes each is over the byte limit
    expect(altFits('👩‍👩'.repeat(2000))).toBe(false)
    expect(altFits('')).toBe(false)
  })
})

describe('matching the image shown', () => {
  const record = parseProfileAlt({
    avatar: {image: AVATAR, alt: 'Fox.'},
    banner: {image: BANNER, alt: 'Forest.'},
    updatedAt: '2026-10-26T12:00:00Z',
  })

  it('finds the CID in CDN and getBlob URLs', () => {
    expect(cidOfImageUrl(cdn('avatar', AVATAR))).toBe(AVATAR)
    expect(cidOfImageUrl(cdn('avatar_thumbnail', AVATAR))).toBe(AVATAR)
    expect(
      cidOfImageUrl(
        `https://pds.example/xrpc/com.atproto.sync.getBlob?did=${DID}&cid=${BANNER}`,
      ),
    ).toBe(BANNER)
    expect(cidOfImageUrl('https://example.com/avatar.png')).toBeUndefined()
    expect(cidOfImageUrl('file:///tmp/picked.jpg')).toBeUndefined()
    expect(cidOfImageUrl(undefined)).toBeUndefined()
  })

  it('describes an image only while its CID is the one shown', () => {
    expect(altForImage(record, 'avatar', cdn('avatar', AVATAR))).toBe('Fox.')
    expect(altForImage(record, 'banner', cdn('banner', BANNER))).toBe('Forest.')
    // A new avatar, or a plural member's shown in its place
    expect(
      altForImage(record, 'avatar', cdn('avatar', NEW_AVATAR)),
    ).toBeUndefined()
    // Each slot describes its own image only
    expect(altForImage(record, 'banner', cdn('banner', AVATAR))).toBeUndefined()
    expect(altForImage(null, 'avatar', cdn('avatar', AVATAR))).toBeUndefined()
    expect(altForImage(record, 'avatar', undefined)).toBeUndefined()
  })

  it('joins a description after the label, never in place of it', () => {
    expect(labelWithAlt('View profile banner', 'Forest.')).toBe(
      'View profile banner. Image description: Forest.',
    )
    expect(labelWithAlt('View profile banner', undefined)).toBe(
      'View profile banner',
    )
  })
})

describe('the record to write', () => {
  it('leaves out empty slots and images that are gone', () => {
    expect(
      nextSlots(
        {avatar: '  Fox.  ', banner: '   '},
        {avatar: AVATAR, banner: BANNER},
      ),
    ).toEqual({avatar: {image: AVATAR, alt: 'Fox.'}})
    expect(nextSlots({avatar: 'Fox.', banner: 'Forest.'}, {})).toEqual({})
  })

  it('keeps unknown keys and sets updatedAt', () => {
    const record = buildProfileAltRecord(
      {
        $type: ALT,
        banner: {image: BANNER, alt: 'Old.'},
        updatedAt: '2020-01-01T00:00:00Z',
        somethingNew: {x: 1},
      },
      {avatar: {image: AVATAR, alt: 'Fox.'}},
      '2026-10-26T12:00:00.000Z',
    )
    expect(record).toEqual({
      $type: ALT,
      avatar: {image: AVATAR, alt: 'Fox.'},
      somethingNew: {x: 1},
      updatedAt: '2026-10-26T12:00:00.000Z',
    })
  })

  it('is nothing when it would hold nothing', () => {
    expect(
      buildProfileAltRecord(
        {$type: ALT, avatar: {image: AVATAR, alt: 'Fox.'}, updatedAt: 'x'},
        {},
        '2026-10-26T12:00:00.000Z',
      ),
    ).toBeNull()
  })

  it('compares slots by image and text', () => {
    const fox = {avatar: {image: AVATAR, alt: 'Fox.'}}
    expect(sameSlots(fox, {avatar: {image: AVATAR, alt: 'Fox.'}})).toBe(true)
    expect(sameSlots(fox, {avatar: {image: NEW_AVATAR, alt: 'Fox.'}})).toBe(
      false,
    )
    expect(sameSlots(fox, {})).toBe(false)
  })
})

describe('reading and saving one’s own record', () => {
  let repo: ReturnType<typeof createRepo>
  let qc: QueryClient
  let w: ProfileAltWriter
  let unregister: () => void

  beforeEach(() => {
    resetIdentityReads()
    repo = createRepo(DID)
    qc = new QueryClient({defaultOptions: {queries: {retry: false}}})
    w = {did: DID, pdsClient: repo.client, queryClient: qc}
    unregister = registerOwnIdentityClient(DID, repo.client)
  })

  afterEach(() => {
    unregister()
    qc.clear()
  })

  async function read(): Promise<ProfileAltAnswer> {
    return fetchProfileAlt(DID)
  }

  it('reads none, then a record with its CID', async () => {
    expect(await read()).toEqual({record: null})
    const cid = repo.seed(ALT, 'self', {
      $type: ALT,
      avatar: {image: AVATAR, alt: 'Fox.'},
      updatedAt: '2026-10-26T12:00:00Z',
    })
    const answer = await read()
    expect(answer.cid).toBe(cid)
    expect(answer.record?.avatar?.alt).toBe('Fox.')
  })

  it('fails a read the PDS cannot answer', async () => {
    unregister()
    await expect(fetchProfileAlt(DID)).rejects.toBeInstanceOf(IdentityReadError)
  })

  it('reads the saved profile’s image CIDs', async () => {
    expect(await readOwnProfileImageCids(w)).toEqual({})
    repo.seed(PROFILE, 'self', {
      $type: PROFILE,
      avatar: blob(AVATAR),
      banner: blob(BANNER),
    })
    expect(await readOwnProfileImageCids(w)).toEqual({
      avatar: AVATAR,
      banner: BANNER,
    })
  })

  it('creates the record for the image in the profile', async () => {
    await saveProfileAlt(
      w,
      await read(),
      {avatar: 'Fox.', banner: ''},
      {avatar: AVATAR, banner: BANNER},
    )
    const [put] = repo.writesOf('putRecord')
    expect(put.body.swapRecord).toBeNull()
    expect(put.body.record).toMatchObject({
      $type: ALT,
      avatar: {image: AVATAR, alt: 'Fox.'},
    })
    expect(put.body.record).not.toHaveProperty('banner')
    const cached = qc.getQueryData<ProfileAltAnswer>(profileAltQueryKey(DID))
    expect(cached?.record?.avatar?.alt).toBe('Fox.')
    expect(cached?.cid).toBe(repo.get(ALT, 'self')?.cid)
  })

  it('writes nothing when the slots do not change', async () => {
    repo.seed(ALT, 'self', {
      $type: ALT,
      avatar: {image: AVATAR, alt: 'Fox.'},
      updatedAt: '2026-10-26T12:00:00Z',
    })
    await saveProfileAlt(
      w,
      await read(),
      {avatar: 'Fox.', banner: ''},
      {avatar: AVATAR},
    )
    expect(repo.writes).toHaveLength(0)
    await saveProfileAlt(
      {...w},
      {record: null},
      {avatar: '', banner: ''},
      {avatar: AVATAR},
    )
    expect(repo.writes).toHaveLength(0)
  })

  it('moves a description to a new image, swapping on the CID read', async () => {
    const first = repo.seed(ALT, 'self', {
      $type: ALT,
      avatar: {image: AVATAR, alt: 'Fox.'},
      extra: 'kept',
      updatedAt: '2026-10-26T12:00:00Z',
    })
    await saveProfileAlt(
      w,
      await read(),
      {avatar: 'A new fox.', banner: ''},
      {avatar: NEW_AVATAR},
    )
    const [put] = repo.writesOf('putRecord')
    expect(put.body.swapRecord).toBe(first)
    expect(put.body.record).toMatchObject({
      avatar: {image: NEW_AVATAR, alt: 'A new fox.'},
      extra: 'kept',
    })
  })

  it('deletes a record left with nothing', async () => {
    repo.seed(ALT, 'self', {
      $type: ALT,
      avatar: {image: AVATAR, alt: 'Fox.'},
      updatedAt: '2026-10-26T12:00:00Z',
    })
    await saveProfileAlt(
      w,
      await read(),
      {avatar: '', banner: ''},
      {avatar: AVATAR},
    )
    expect(repo.writesOf('putRecord')).toHaveLength(0)
    expect(repo.writesOf('deleteRecord')).toHaveLength(1)
    expect(repo.get(ALT, 'self')).toBeUndefined()
    expect(qc.getQueryData<ProfileAltAnswer>(profileAltQueryKey(DID))).toEqual({
      record: null,
    })
  })

  it('refuses to overwrite a record changed elsewhere', async () => {
    repo.seed(ALT, 'self', {
      $type: ALT,
      avatar: {image: AVATAR, alt: 'Fox.'},
      updatedAt: '2026-10-26T12:00:00Z',
    })
    const stale = await read()
    repo.seed(ALT, 'self', {
      $type: ALT,
      avatar: {image: AVATAR, alt: 'Written elsewhere.'},
      updatedAt: '2026-10-26T12:01:00Z',
    })
    await expect(
      saveProfileAlt(w, stale, {avatar: 'Mine.', banner: ''}, {avatar: AVATAR}),
    ).rejects.toBeInstanceOf(IdentityWriteConflictError)
    expect(repo.get(ALT, 'self')?.value).toMatchObject({
      avatar: {alt: 'Written elsewhere.'},
    })
  })

  it('writes nothing over the limit', async () => {
    await expect(
      saveProfileAlt(
        w,
        {record: null},
        {avatar: '👩‍👩'.repeat(2000), banner: ''},
        {avatar: AVATAR},
      ),
    ).rejects.toBeInstanceOf(ProfileAltTooLongError)
    expect(repo.writes).toHaveLength(0)
  })
})

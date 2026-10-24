import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * Phase 5 design 13, the 5C writes (B-12): the pronouns editor's writes
 * (two sets, forms kept whole, timestamps, the 25-grapheme refusal, no
 * delete, empty `sets`), member rkeys (TIDs, `createRecord` only, never
 * reused), editors keeping unknown data, the front's 20-member cap, the
 * optimistic cache with rollback, and removing a system of 450 members.
 * Fixtures only: a fake PDS behind a lex client; no network call.
 */

jest.unmock('multiformats/cid')
jest.mock('#/lib/api/upload-blob', () => ({
  uploadBlob: jest.fn(),
}))
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

import {TID} from '@atproto/common-web'
import {jsonToLex} from '@atproto/lex'
import {i18n} from '@lingui/core'
import {QueryClient} from '@tanstack/react-query'

import {uploadBlob} from '#/lib/api/upload-blob'
import {
  choicesFrom,
  frontMembersFrom,
} from '#/horizon/identity/edit/front-model'
import {
  ACCOUNT_PRONOUN_LIMITS,
  editRow,
  newRow,
  rowProblem,
  rowsFromSets,
  rowsValid,
  setsFromRows,
} from '#/horizon/identity/edit/pronoun-rows'
import {parseFront, parseMember, parsePronouns} from '#/horizon/identity/parse'
import {
  type IdentityAnswer,
  identityQueryKey,
  type MemberList,
} from '#/horizon/identity/queries'
import {
  buildPronounsRecord,
  createMember,
  deleteMember,
  FRONT_MAX_MEMBERS,
  frontProblem,
  IdentityInvalidError,
  IdentityWriteConflictError,
  MemberImageError,
  type MemberInput,
  type OwnWriter,
  PluralRemovalIncompleteError,
  REMOVE_BATCH,
  removePluralSystem,
  saveFront,
  savePronouns,
  saveSystem,
  setUpSystem,
  updateMember,
} from '#/horizon/identity/writes'
import * as tidClock from '#/horizon/tid-clock'
import {cidOf, createRepo} from './write-harness'

i18n.loadAndActivate({locale: 'en', messages: {}})

const DID = 'did:plc:writeraaaaaaaaaaaaaaaaaa'
const PRONOUNS = 'app.nearhorizon.actor.pronouns'
const SYSTEM = 'app.nearhorizon.plural.system'
const MEMBER = 'app.nearhorizon.plural.member'
const FRONT = 'app.nearhorizon.plural.front'

let repo: ReturnType<typeof createRepo>
let qc: QueryClient
let w: OwnWriter

beforeEach(() => {
  repo = createRepo(DID)
  qc = new QueryClient({defaultOptions: {queries: {retry: false}}})
  w = {did: DID, pdsClient: repo.client, queryClient: qc}
})

afterEach(() => {
  qc.clear()
  jest.useRealTimers()
})

function input(overrides: Partial<MemberInput> = {}): MemberInput {
  return {
    displayName: 'Wren',
    description: '',
    emoji: '',
    color: '',
    pronouns: [],
    roles: [],
    memberTypes: [],
    agePresentation: '',
    proxy: null,
    ...overrides,
  }
}

/** The pronouns answer as an editor reads it: the stored record, parsed. */
function readPronouns(): IdentityAnswer<
  NonNullable<ReturnType<typeof parsePronouns>>
> {
  const stored = repo.get(PRONOUNS, 'self')
  if (!stored) return {kind: 'none'}
  const value = parsePronouns(stored.value)
  if (!value) throw new Error('stored pronouns do not parse')
  return {kind: 'record', value, cid: stored.cid}
}

function lastRecord(method: string) {
  const calls = repo.writesOf(method)
  return calls[calls.length - 1]?.body.record
}

describe('pronouns editor writes', () => {
  it('typing she/her then a second row fae/faer/faerself writes two sets', async () => {
    let rows = [newRow()]
    rows = [editRow(rows[0], 'she/her'), editRow(newRow(), 'fae/faer/faerself')]
    await savePronouns(
      w,
      {kind: 'none'},
      {
        sets: setsFromRows(rows),
        displayMode: 'all',
      },
    )
    const record = lastRecord('putRecord')
    expect(record.sets).toEqual([
      {forms: ['she', 'her']},
      {forms: ['fae', 'faer', 'faerself']},
    ])
    expect(repo.writesOf('putRecord')[0].body.swapRecord).toBeNull()
  })

  it('keeps a form with commas or middle dots whole', async () => {
    const rows = [editRow(newRow(), 'they · it, sometimes/them')]
    await savePronouns(
      w,
      {kind: 'none'},
      {
        sets: setsFromRows(rows),
        displayMode: 'all',
      },
    )
    expect(lastRecord('putRecord').sets).toEqual([
      {forms: ['they · it, sometimes', 'them']},
    ])
  })

  it('has no updatedAt on the first write, then keeps createdAt and sets updatedAt', async () => {
    jest.useFakeTimers({now: new Date('2026-10-24T10:00:00.000Z')})
    await savePronouns(
      w,
      {kind: 'none'},
      {
        sets: [{forms: ['she', 'her']}],
        displayMode: 'all',
      },
    )
    const first = lastRecord('putRecord')
    expect(first.createdAt).toBe('2026-10-24T10:00:00.000Z')
    expect('updatedAt' in first).toBe(false)

    jest.setSystemTime(new Date('2026-10-25T09:30:00.000Z'))
    await savePronouns(w, readPronouns(), {
      sets: [{forms: ['she', 'they']}],
      displayMode: 'all',
    })
    const second = lastRecord('putRecord')
    expect(second.createdAt).toBe('2026-10-24T10:00:00.000Z')
    expect(second.updatedAt).toBe('2026-10-25T09:30:00.000Z')
    // Swapped on the CID of the first write.
    expect(repo.writesOf('putRecord')[1].body.swapRecord).toBe(cidOf(1))
  })

  it('refuses a 25-grapheme form and never cuts it', async () => {
    const long = 'abcdefghijklmnopqrstuvwxy'
    const row = editRow(newRow(), `she/${long}`)
    expect(rowProblem(row, ACCOUNT_PRONOUN_LIMITS)).toEqual({
      kind: 'formTooLong',
      form: long,
    })
    expect(rowsValid([row], ACCOUNT_PRONOUN_LIMITS)).toBe(false)
    // 24 graphemes fit, and so do 17 four-byte emoji (68 bytes) since the
    // limit is 240 bytes; 10 family emoji (25 bytes each, 250) are over it.
    expect(
      rowProblem(editRow(newRow(), long.slice(0, 24)), ACCOUNT_PRONOUN_LIMITS),
    ).toBeNull()
    expect(
      rowProblem(editRow(newRow(), '🌿'.repeat(17)), ACCOUNT_PRONOUN_LIMITS),
    ).toBeNull()
    expect(
      rowProblem(editRow(newRow(), '👩‍👩‍👧‍👦'.repeat(10)), ACCOUNT_PRONOUN_LIMITS),
    ).toEqual({kind: 'formTooLong', form: '👩‍👩‍👧‍👦'.repeat(10)})
    await expect(
      savePronouns(
        w,
        {kind: 'none'},
        {
          sets: setsFromRows([row]),
          displayMode: 'all',
        },
      ),
    ).rejects.toBeInstanceOf(IdentityInvalidError)
    expect(repo.writes).toHaveLength(0)
  })

  it('clearing every row writes empty sets, keeping the record; nothing deletes it', async () => {
    repo.seed(PRONOUNS, 'self', {
      $type: PRONOUNS,
      sets: [{forms: ['he', 'him']}],
      createdAt: '2026-10-01T00:00:00.000Z',
    })
    await savePronouns(w, readPronouns(), {sets: [], displayMode: 'all'})
    expect(lastRecord('putRecord').sets).toEqual([])
    expect(repo.get(PRONOUNS, 'self')).toBeDefined()
    expect(repo.writesOf('deleteRecord')).toHaveLength(0)
    expect(repo.writesOf('applyWrites')).toHaveLength(0)
  })

  it('"Show no pronouns" with no record writes a record with empty sets', async () => {
    await savePronouns(w, {kind: 'none'}, {sets: [], displayMode: 'all'})
    const record = lastRecord('putRecord')
    expect(record).toMatchObject({$type: PRONOUNS, sets: []})
    expect(repo.writesOf('putRecord')[0].body.swapRecord).toBeNull()
  })

  it('keeps an unknown key and an untouched single form "he/him" as read', async () => {
    repo.seed(PRONOUNS, 'self', {
      $type: PRONOUNS,
      sets: [{forms: ['he/him'], note: 'kept'}, {forms: ['they', 'them']}],
      createdAt: '2026-10-01T00:00:00.000Z',
      'com.example.extra': {flag: true},
    })
    const read = readPronouns()
    if (read.kind !== 'record') throw new Error('expected a record')
    const rows = rowsFromSets(read.value.sets)
    // Edit only the second row.
    rows[1] = editRow(rows[1], 'they/them/theirs')
    await savePronouns(w, read, {
      sets: setsFromRows(rows),
      displayMode: read.value.displayMode,
    })
    const record = lastRecord('putRecord')
    expect(record['com.example.extra']).toEqual({flag: true})
    expect(record.sets).toEqual([
      {forms: ['he/him'], note: 'kept'},
      {forms: ['they', 'them', 'theirs']},
    ])
    expect('displayMode' in record).toBe(false)
  })

  it('sets the cache at once and rolls back when the write fails', async () => {
    repo.failures.set('com.atproto.repo.putRecord', 0)
    const key = identityQueryKey('pronouns', {did: DID})
    qc.setQueryData(key, {kind: 'none'})
    const pending = savePronouns(
      w,
      {kind: 'none'},
      {
        sets: [{forms: ['xe', 'xem']}],
        displayMode: 'all',
      },
    )
    expect(qc.getQueryData<IdentityAnswer<unknown>>(key)?.kind).toBe('record')
    await expect(pending).rejects.toBeDefined()
    expect(qc.getQueryData(key)).toEqual({kind: 'none'})
  })

  it('a record changed elsewhere fails the swap instead of overwriting', async () => {
    repo.seed(PRONOUNS, 'self', {
      $type: PRONOUNS,
      sets: [{forms: ['he', 'him']}],
      createdAt: '2026-10-01T00:00:00.000Z',
    })
    const read = readPronouns()
    repo.seed(PRONOUNS, 'self', {
      $type: PRONOUNS,
      sets: [{forms: ['she', 'her']}],
      createdAt: '2026-10-01T00:00:00.000Z',
    })
    await expect(
      savePronouns(w, read, {sets: [], displayMode: 'all'}),
    ).rejects.toBeInstanceOf(IdentityWriteConflictError)
    expect((repo.get(PRONOUNS, 'self')?.value as {sets: unknown}).sets).toEqual(
      [{forms: ['she', 'her']}],
    )
  })

  it('refuses to write over a record that was never read', async () => {
    await expect(
      savePronouns(w, undefined, {sets: [], displayMode: 'all'}),
    ).rejects.toBeDefined()
    expect(repo.writes).toHaveLength(0)
  })

  it('a display mode change writes it; an untouched mode keeps the record’s', () => {
    const read = parsePronouns({
      $type: PRONOUNS,
      sets: [{forms: ['a']}],
      displayMode: 'sparkly',
      createdAt: '2026-10-01T00:00:00.000Z',
    })!
    expect(
      buildPronounsRecord(
        read,
        {sets: [{forms: ['a']}], displayMode: 'all'},
        'x',
      ).displayMode,
    ).toBe('sparkly')
    expect(
      buildPronounsRecord(
        read,
        {sets: [{forms: ['a']}], displayMode: 'firstOnly'},
        'x',
      ).displayMode,
    ).toBe('firstOnly')
  })
})

describe('member writes', () => {
  it('a member created from a name gets a TID, by createRecord, never putRecord', async () => {
    const rkey = await createMember(w, input({displayName: 'Wren'}))
    expect(TID.is(rkey)).toBe(true)
    expect(rkey).not.toContain('wren')
    expect(repo.writesOf('createRecord')).toHaveLength(1)
    expect(repo.writesOf('createRecord')[0].body).toMatchObject({
      repo: DID,
      collection: MEMBER,
      rkey,
    })
    expect(repo.writesOf('putRecord')).toHaveLength(0)
    expect(repo.get(MEMBER, rkey)).toBeDefined()
  })

  it('a deleted member’s rkey is never produced again', async () => {
    const first = await createMember(w, input({displayName: 'Wren'}))
    await deleteMember(w, first, undefined)
    expect(repo.get(MEMBER, first)).toBeUndefined()
    const seen = new Set([first])
    for (let i = 0; i < 25; i++) {
      const rkey = await createMember(w, input({displayName: 'Wren'}))
      expect(seen.has(rkey)).toBe(false)
      seen.add(rkey)
    }
  })

  it('a clash fails instead of overwriting', async () => {
    const rkey = await createMember(w, input({displayName: 'Wren'}))
    const before = repo.get(MEMBER, rkey)
    // The clock hands out the same rkey again (a same-microsecond clash).
    jest.spyOn(tidClock, 'nextTidStr').mockReturnValueOnce(rkey)
    await expect(
      createMember(w, input({displayName: 'Sparrow'})),
    ).rejects.toBeDefined()
    expect(repo.writesOf('createRecord')).toHaveLength(2)
    expect(repo.get(MEMBER, rkey)).toEqual(before)
    expect(repo.writesOf('putRecord')).toHaveLength(0)
  })

  it('keeps unknown keys on an edit and drops Horizon 1.0’s off-spec fields', async () => {
    const cid = repo.seed(MEMBER, '3m4kq2xv7ad2c', {
      $type: MEMBER,
      displayName: 'Wren',
      pronouns: [{forms: ['he/him']}],
      pronounDisplayMode: 'firstOnly',
      externalUrl: 'https://example.com',
      'com.example.extra': 1,
      createdAt: '2026-10-01T00:00:00.000Z',
    })
    const value = parseMember(repo.get(MEMBER, '3m4kq2xv7ad2c')!.value)!
    const rows = rowsFromSets(value.pronouns)
    await updateMember(
      w,
      '3m4kq2xv7ad2c',
      {value, cid},
      input({displayName: 'Wren', pronouns: setsFromRows(rows)}),
    )
    const record = lastRecord('putRecord')
    expect(record['com.example.extra']).toBe(1)
    expect(record.pronouns).toEqual([{forms: ['he/him']}])
    expect('pronounDisplayMode' in record).toBe(false)
    expect('externalUrl' in record).toBe(false)
    expect(record.createdAt).toBe('2026-10-01T00:00:00.000Z')
    expect(repo.writesOf('putRecord')[0].body.swapRecord).toBe(cid)
  })

  it('keeps roles and member types in their own fields', async () => {
    const rkey = await createMember(
      w,
      input({roles: ['host', 'protector'], memberTypes: ['fronter']}),
    )
    const record = repo.get(MEMBER, rkey)!.value as Record<string, unknown>
    expect(record.roles).toEqual(['host', 'protector'])
    expect(record.memberTypes).toEqual(['fronter'])
  })

  it('refuses a missing name, a bad colour and over-limit lists', async () => {
    await expect(
      createMember(w, input({displayName: '  '})),
    ).rejects.toBeInstanceOf(IdentityInvalidError)
    await expect(createMember(w, input({color: 'red'}))).rejects.toBeInstanceOf(
      IdentityInvalidError,
    )
    await expect(
      createMember(w, input({memberTypes: ['a', 'b', 'c', 'd', 'e', 'f']})),
    ).rejects.toBeInstanceOf(IdentityInvalidError)
    await expect(
      createMember(
        w,
        input({pronouns: [{forms: ['abcdefghijklmnopqrstuvwxy']}]}),
      ),
    ).rejects.toBeInstanceOf(IdentityInvalidError)
    expect(repo.writes).toHaveLength(0)
  })

  it('uploads a new avatar before the create and writes its blob', async () => {
    const blob = jsonToLex({
      $type: 'blob',
      ref: {$link: cidOf(900)},
      mimeType: 'image/png',
      size: 2048,
    })
    jest.mocked(uploadBlob).mockResolvedValueOnce({blob} as never)
    const rkey = await createMember(w, input(), {
      avatar: {path: 'file:///a.png', mime: 'image/png', size: 2048},
    })
    expect(uploadBlob).toHaveBeenCalledWith(
      repo.client,
      'file:///a.png',
      'image/png',
    )
    const record = repo.get(MEMBER, rkey)!.value as {
      avatar: {ref: {$link: string}}
    }
    expect(record.avatar.ref.$link).toBe(cidOf(900))
  })

  it('refuses a GIF image without uploading it', async () => {
    jest.mocked(uploadBlob).mockClear()
    await expect(
      createMember(w, input(), {
        avatar: {path: 'file:///a.gif', mime: 'image/gif', size: 10},
      }),
    ).rejects.toBeInstanceOf(MemberImageError)
    expect(uploadBlob).not.toHaveBeenCalled()
    expect(repo.writes).toHaveLength(0)
  })

  it('a new member enters the cached list in ascending rkey order', async () => {
    const listKey = identityQueryKey('members', {did: DID})
    const early = {
      rkey: '2aaaaaaaaaaaa',
      value: parseMember({$type: MEMBER, displayName: 'Old'})!,
    }
    qc.setQueryData<MemberList>(listKey, {members: [early], partial: false})
    const rkey = await createMember(w, input({displayName: 'New'}))
    const list = qc.getQueryData<MemberList>(listKey)!
    expect(list.members.map(m => m.rkey)).toEqual([early.rkey, rkey])
    expect(
      qc.getQueryData<IdentityAnswer<unknown>>(
        identityQueryKey('member', {did: DID, rkey}),
      )?.kind,
    ).toBe('record')
  })

  it('deleting a member drops it from the front, keeping the others', async () => {
    const wren = await createMember(w, input({displayName: 'Wren'}))
    const sparrow = await createMember(w, input({displayName: 'Sparrow'}))
    const frontCid = repo.seed(FRONT, 'self', {
      $type: FRONT,
      members: [{id: wren}, {id: sparrow, status: 'co-conscious'}],
      state: 'co-fronting',
      setAt: '2026-10-24T00:00:00.000Z',
    })
    const front = parseFront(repo.get(FRONT, 'self')!.value)!
    await deleteMember(w, wren, {kind: 'record', value: front, cid: frontCid})
    const written = repo.get(FRONT, 'self')!.value as Record<string, unknown>
    expect(written.members).toEqual([{id: sparrow, status: 'co-conscious'}])
    expect(written.state).toBe('co-fronting')
    expect(written.setAt).toBe('2026-10-24T00:00:00.000Z')
  })
})

describe('system and front writes', () => {
  it('"Set up a plural system" writes an empty system record, create-only', async () => {
    await setUpSystem(w)
    const call = repo.writesOf('putRecord')[0]
    expect(call.body).toMatchObject({collection: SYSTEM, rkey: 'self'})
    expect(call.body.swapRecord).toBeNull()
    expect(Object.keys(call.body.record).sort()).toEqual(['$type', 'createdAt'])
    expect(
      qc.getQueryData<IdentityAnswer<unknown>>(
        identityQueryKey('system', {did: DID}),
      )?.kind,
    ).toBe('record')
  })

  it('saving the system keeps unknown keys and drops old-client fields', async () => {
    const cid = repo.seed(SYSTEM, 'self', {
      $type: SYSTEM,
      name: 'Old name',
      avatar: {$type: 'blob', ref: {$link: cidOf(5)}, mimeType: 'image/png'},
      'com.example.extra': 'kept',
      createdAt: '2026-10-01T00:00:00.000Z',
    })
    await saveSystem(
      w,
      {
        kind: 'record',
        value: {
          name: 'Old name',
          raw: repo.get(SYSTEM, 'self')!.value as Record<string, unknown>,
        },
        cid,
      },
      {
        name: 'The Flock',
        description: '',
        collectiveNoun: 'flock',
        memberCount: '20+',
      },
    )
    const record = lastRecord('putRecord')
    expect(record).toMatchObject({
      name: 'The Flock',
      collectiveNoun: 'flock',
      memberCount: '20+',
      'com.example.extra': 'kept',
      createdAt: '2026-10-01T00:00:00.000Z',
    })
    expect('avatar' in record).toBe(false)
    expect('description' in record).toBe(false)
  })

  it('the front holds at most 20 members', async () => {
    const ids = Array.from({length: FRONT_MAX_MEMBERS + 1}, (_, i) =>
      TID.fromTime(1_700_000_000_000_000 + i, 1).toString(),
    )
    const tooMany = {
      members: ids.map(id => ({id, status: 'engaging'})),
      state: '',
      comment: '',
    }
    expect(frontProblem(tooMany)).toBe('tooManyMembers')
    await expect(saveFront(w, {kind: 'none'}, tooMany)).rejects.toBeInstanceOf(
      IdentityInvalidError,
    )
    const twenty = {...tooMany, members: tooMany.members.slice(0, 20)}
    expect(frontProblem(twenty)).toBeNull()
    await saveFront(w, {kind: 'none'}, twenty)
    expect((lastRecord('putRecord').members as unknown[]).length).toBe(20)
  })

  it('"Nobody fronting" writes empty members and keeps the state, comment and unknown keys', async () => {
    jest.useFakeTimers({now: new Date('2026-10-24T12:00:00.000Z')})
    const cid = repo.seed(FRONT, 'self', {
      $type: FRONT,
      members: [{id: '3m4kq2xv7ad2c'}],
      state: 'solo',
      comment: 'hi',
      setAt: '2026-10-20T00:00:00.000Z',
      'com.example.extra': true,
    })
    const value = parseFront(repo.get(FRONT, 'self')!.value)!
    await saveFront(
      w,
      {kind: 'record', value, cid},
      {
        members: [],
        state: 'solo',
        comment: 'hi',
      },
    )
    const record = lastRecord('putRecord')
    expect(record).toMatchObject({
      members: [],
      state: 'solo',
      comment: 'hi',
      setAt: '2026-10-24T12:00:00.000Z',
      'com.example.extra': true,
    })
    expect(repo.writesOf('putRecord')[0].body.swapRecord).toBe(cid)
  })
})

describe('the front switcher’s model', () => {
  const member = (rkey: string) => ({
    rkey,
    value: parseMember({$type: MEMBER, displayName: rkey})!,
  })

  it('reads an absent status as engaging and an unknown one as Other…', () => {
    const choices = choicesFrom(
      parseFront({
        $type: FRONT,
        members: [{id: 'aaa'}, {id: 'bbb', status: 'co-front'}],
        setAt: '2026-10-24T00:00:00.000Z',
      })!,
    )
    expect(choices.get('aaa')).toEqual({status: 'engaging', other: false})
    expect(choices.get('bbb')).toEqual({status: 'co-front', other: true})
  })

  it('writes members in list order and drops ids a complete list lacks', () => {
    const choices = new Map([
      ['ccc', {status: 'observing', other: false}],
      ['aaa', {status: '', other: true}],
      ['gone', {status: 'engaging', other: false}],
    ])
    const list = {members: [member('aaa'), member('bbb'), member('ccc')]}
    expect(frontMembersFrom(choices, {...list, partial: false})).toEqual([
      {id: 'aaa', status: 'engaging'},
      {id: 'ccc', status: 'observing'},
    ])
    expect(
      frontMembersFrom(choices, {...list, partial: true}).map(m => m.id),
    ).toEqual(['aaa', 'ccc', 'gone'])
  })
})

describe('removing the plural system', () => {
  function seedSystem(members: number) {
    repo.seed(SYSTEM, 'self', {$type: SYSTEM, name: 'The Flock'})
    repo.seed(FRONT, 'self', {
      $type: FRONT,
      members: [],
      setAt: '2026-10-24T00:00:00.000Z',
    })
    for (let i = 0; i < members; i++) {
      const rkey = TID.fromTime(1_700_000_000_000_000 + i * 1000, 3).toString()
      repo.seed(MEMBER, rkey, {$type: MEMBER, displayName: `Member ${i}`})
    }
    // One member another client wrote that Horizon cannot parse.
    repo.seed(MEMBER, 'zzzunparsed', {$type: MEMBER})
  }

  it('removes a system of 450 members: the system record first, then calls of at most 200', async () => {
    seedSystem(450)
    await removePluralSystem(w)
    const order = repo.writes.map(write => write.method)
    expect(order[0]).toBe('com.atproto.repo.deleteRecord')
    expect(repo.writes[0].body).toMatchObject({
      collection: SYSTEM,
      rkey: 'self',
    })
    const batches = repo.writesOf('applyWrites')
    expect(batches.length).toBe(3)
    for (const batch of batches) {
      expect(batch.body.writes.length).toBeLessThanOrEqual(REMOVE_BATCH)
    }
    const deleted = batches.flatMap(
      b => b.body.writes as {collection: string}[],
    )
    expect(deleted.filter(d => d.collection === MEMBER)).toHaveLength(451)
    expect(deleted.filter(d => d.collection === FRONT)).toHaveLength(1)
    expect(repo.records.size).toBe(0)
    expect(qc.getQueryData(identityQueryKey('system', {did: DID}))).toEqual({
      kind: 'none',
    })
    expect(
      qc.getQueryData<MemberList>(identityQueryKey('members', {did: DID})),
    ).toEqual({members: [], partial: false})
  })

  it('a failure after the first call leaves no system record, and trying again deletes the rest', async () => {
    seedSystem(450)
    repo.failures.set('com.atproto.repo.applyWrites', 1)
    await expect(removePluralSystem(w)).rejects.toBeInstanceOf(
      PluralRemovalIncompleteError,
    )
    expect(repo.get(SYSTEM, 'self')).toBeUndefined()
    expect(repo.records.size).toBeGreaterThan(0)

    repo.failures.delete('com.atproto.repo.applyWrites')
    await removePluralSystem(w)
    expect(repo.records.size).toBe(0)
  })

  it('a failure before the system record is gone changes nothing', async () => {
    seedSystem(3)
    const key = identityQueryKey('system', {did: DID})
    const cached = {kind: 'record', value: {raw: {}}}
    qc.setQueryData(key, cached)
    repo.failures.set('com.atproto.repo.deleteRecord', 0)
    await expect(removePluralSystem(w)).rejects.not.toBeInstanceOf(
      PluralRemovalIncompleteError,
    )
    expect(repo.get(SYSTEM, 'self')).toBeDefined()
    expect(repo.writesOf('applyWrites')).toHaveLength(0)
    expect(qc.getQueryData(key)).toEqual(cached)
  })
})

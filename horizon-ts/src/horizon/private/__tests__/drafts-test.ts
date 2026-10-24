import {type Client} from '@atproto/lex'
import {beforeEach, describe, expect, it} from '@jest/globals'

import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {readLocal, writeLocal} from '#/horizon/session/local-store'
import {
  applyDraftVisibility,
  captureDraftVisibility,
  isPrivateDraft,
  MAX_DRAFT_ENTRIES,
  readDraftTable,
  recordDraftVisibility,
} from '../composer/drafts'
import {
  getComposeVisibility,
  PUBLIC_COMPOSE,
  setComposeVisibility,
} from '../composer/state'
import {AUDIENCE, DID} from './fixtures'

const client = {} as Client

const UNSAVED_RESTORE = {
  visibility: 'private',
  audience: {kind: 'unpicked', why: 'unsaved'},
  locked: false,
}

/** A recorded Public save, restored (P5R8-Q1). */
const PUBLIC_DRAFT_RESTORE = {
  visibility: 'public',
  audience: {kind: 'unpicked', why: 'draft'},
  locked: false,
}

beforeEach(() => {
  writeLocal(`horizon:draft-visibility:${DID}`, undefined)
  setComposeVisibility(PUBLIC_COMPOSE)
  clearCurrentClients()
  publishCurrentClients({
    did: DID,
    handle: 'alice.test',
    pdsUrl: 'https://pds.example',
    pdsClient: client,
    prismClient: client,
    appviewClient: client,
  })
})

describe('the draft visibility table', () => {
  it('saving while Private records visibility and audience under the draft id', () => {
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'list', uri: AUDIENCE},
      locked: false,
    })
    recordDraftVisibility('draft-1', captureDraftVisibility())
    expect(readDraftTable(DID)).toEqual([
      {
        id: 'draft-1',
        visibility: 'private',
        audience: {kind: 'list', uri: AUDIENCE},
      },
    ])
    expect(readLocal(`horizon:draft-visibility:${DID}`)).toBeDefined()
  })

  it('saving while Public records a Public entry in place of the Private one', () => {
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'followers'},
      locked: false,
    })
    recordDraftVisibility('draft-1', captureDraftVisibility())
    setComposeVisibility(PUBLIC_COMPOSE)
    recordDraftVisibility('draft-1', captureDraftVisibility())
    expect(readDraftTable(DID)).toEqual([{id: 'draft-1', visibility: 'public'}])
  })

  it('a draft saved Public restores Public with no tap, holding no audience for a flip (P5R8-Q1)', () => {
    setComposeVisibility(PUBLIC_COMPOSE)
    recordDraftVisibility('draft-1', captureDraftVisibility())
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'nobody'},
      locked: false,
    })
    applyDraftVisibility('draft-1')
    expect(getComposeVisibility()).toEqual(PUBLIC_DRAFT_RESTORE)
    // Not Everyone: a flip to Private waits for a pick.
    expect(getComposeVisibility().audience).not.toEqual(PUBLIC_COMPOSE.audience)
    // A re-save while Public still records a Public entry.
    recordDraftVisibility('draft-1', captureDraftVisibility())
    expect(readDraftTable(DID)).toEqual([{id: 'draft-1', visibility: 'public'}])
  })

  it('restoring a draft with an entry makes the compose private with that audience', () => {
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'nobody'},
      locked: false,
    })
    recordDraftVisibility('draft-1', captureDraftVisibility())
    setComposeVisibility(PUBLIC_COMPOSE)
    applyDraftVisibility('draft-1')
    expect(getComposeVisibility()).toEqual({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'nobody'},
      locked: false,
    })
  })

  it('restoring a draft without an entry makes the compose Private and unpicked (P5R7-L1)', () => {
    setComposeVisibility(PUBLIC_COMPOSE)
    applyDraftVisibility('draft-unknown')
    expect(getComposeVisibility()).toEqual(UNSAVED_RESTORE)
  })

  it('a draft saved Private restores Private and unpicked once the table is forgotten', () => {
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'list', uri: AUDIENCE},
      locked: false,
    })
    recordDraftVisibility('draft-1', captureDraftVisibility())
    // What `forgetRemovedAccount` does to the table, or another device.
    writeLocal(`horizon:draft-visibility:${DID}`, undefined)
    setComposeVisibility(PUBLIC_COMPOSE)
    applyDraftVisibility('draft-1')
    expect(getComposeVisibility()).toEqual(UNSAVED_RESTORE)
  })

  it('a Private compose with no audience chosen round-trips as Private and unpicked', () => {
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'unpicked', why: 'unsaved'},
      locked: false,
    })
    recordDraftVisibility('draft-1', captureDraftVisibility())
    expect(readDraftTable(DID)).toEqual([
      {id: 'draft-1', visibility: 'private', audience: {kind: 'unpicked'}},
    ])
    setComposeVisibility(PUBLIC_COMPOSE)
    applyDraftVisibility('draft-1')
    expect(getComposeVisibility()).toEqual({
      visibility: 'private',
      audience: {kind: 'unpicked', why: 'draft'},
      locked: false,
    })
    expect(isPrivateDraft('draft-1')).toBe(true)
  })

  it('a parent audience is stored as unpicked, never removed', () => {
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'parent', uri: AUDIENCE},
      locked: true,
    })
    recordDraftVisibility('draft-1', captureDraftVisibility())
    expect(readDraftTable(DID)).toEqual([
      {id: 'draft-1', visibility: 'private', audience: {kind: 'unpicked'}},
    ])
  })

  it('parses fail closed: only visibility "public" is Public', () => {
    writeLocal(
      `horizon:draft-visibility:${DID}`,
      JSON.stringify([
        {id: 'pub', visibility: 'public'},
        {id: 'typo', visibility: 'publik'},
        {id: 'bare'},
        {id: 'newer', visibility: 'private', audience: {kind: 'circle'}},
        {
          id: 'mode',
          visibility: 'private',
          audience: {kind: 'mode', mode: 'x'},
        },
        {id: 'list', visibility: 'private', audience: {kind: 'list'}},
        {visibility: 'public'},
        'junk',
      ]),
    )
    const unpicked = {visibility: 'private', audience: {kind: 'unpicked'}}
    expect(readDraftTable(DID)).toEqual([
      {id: 'pub', visibility: 'public'},
      {id: 'typo', ...unpicked},
      {id: 'bare', ...unpicked},
      {id: 'newer', ...unpicked},
      {id: 'mode', ...unpicked},
      {id: 'list', ...unpicked},
    ])
    applyDraftVisibility('pub')
    expect(getComposeVisibility()).toEqual(PUBLIC_DRAFT_RESTORE)
    applyDraftVisibility('typo')
    expect(getComposeVisibility()).toEqual({
      visibility: 'private',
      audience: {kind: 'unpicked', why: 'draft'},
      locked: false,
    })
    expect(isPrivateDraft('typo')).toBe(true)
    expect(isPrivateDraft('pub')).toBe(false)
  })

  it('a save writes every other entry back as it was read', () => {
    const newer = {
      id: 'newer',
      visibility: 'private',
      audience: {kind: 'circle', members: ['x']},
    }
    writeLocal(`horizon:draft-visibility:${DID}`, JSON.stringify([newer]))
    setComposeVisibility(PUBLIC_COMPOSE)
    recordDraftVisibility('draft-1', captureDraftVisibility())
    expect(JSON.parse(readLocal(`horizon:draft-visibility:${DID}`)!)).toEqual([
      newer,
      {id: 'draft-1', visibility: 'public'},
    ])
  })

  it('keeps at most 200 entries, dropping the oldest first', () => {
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'everyone'},
      locked: false,
    })
    for (let i = 0; i < MAX_DRAFT_ENTRIES + 5; i++) {
      recordDraftVisibility(`draft-${i}`, captureDraftVisibility())
    }
    const table = readDraftTable(DID)
    expect(table).toHaveLength(MAX_DRAFT_ENTRIES)
    expect(table[0].id).toBe('draft-5')
    expect(table[table.length - 1].id).toBe(`draft-${MAX_DRAFT_ENTRIES + 4}`)
  })

  it('re-saving a draft moves it to the newest end', () => {
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'everyone'},
      locked: false,
    })
    recordDraftVisibility('a', captureDraftVisibility())
    recordDraftVisibility('b', captureDraftVisibility())
    recordDraftVisibility('a', captureDraftVisibility())
    expect(readDraftTable(DID).map(entry => entry.id)).toEqual(['b', 'a'])
  })

  it('is kept per account', () => {
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'everyone'},
      locked: false,
    })
    recordDraftVisibility('draft-1', captureDraftVisibility())
    expect(readDraftTable('did:plc:someoneelseaaaaaaaaaaaaa')).toEqual([])
  })

  it('with an unreadable table every draft restores Private and unpicked, and still does after another draft is saved', () => {
    writeLocal(`horizon:draft-visibility:${DID}`, '{not json')
    expect(readDraftTable(DID)).toEqual([])
    setComposeVisibility(PUBLIC_COMPOSE)
    applyDraftVisibility('draft-1')
    expect(getComposeVisibility()).toEqual(UNSAVED_RESTORE)
    setComposeVisibility(PUBLIC_COMPOSE)
    recordDraftVisibility('draft-2', captureDraftVisibility())
    applyDraftVisibility('draft-1')
    expect(getComposeVisibility()).toEqual(UNSAVED_RESTORE)
    expect(isPrivateDraft('draft-1')).toBe(false)
  })

  it('a table that is not an array restores Private and unpicked too', () => {
    writeLocal(`horizon:draft-visibility:${DID}`, '{"id":"draft-1"}')
    setComposeVisibility(PUBLIC_COMPOSE)
    applyDraftVisibility('draft-1')
    expect(getComposeVisibility()).toEqual(UNSAVED_RESTORE)
  })
})

describe('the drafts list lock (round 2 fix 3)', () => {
  it('marks a draft saved Private, and not one saved Public', () => {
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'followers'},
      locked: false,
    })
    recordDraftVisibility('draft-private', captureDraftVisibility())
    setComposeVisibility(PUBLIC_COMPOSE)
    recordDraftVisibility('draft-public', captureDraftVisibility())
    expect(isPrivateDraft('draft-private')).toBe(true)
    expect(isPrivateDraft('draft-public')).toBe(false)
    expect(isPrivateDraft('draft-unknown')).toBe(false)
  })

  it('drops the lock once the draft is saved again Public', () => {
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'everyone'},
      locked: false,
    })
    recordDraftVisibility('draft-1', captureDraftVisibility())
    setComposeVisibility(PUBLIC_COMPOSE)
    recordDraftVisibility('draft-1', captureDraftVisibility())
    expect(isPrivateDraft('draft-1')).toBe(false)
  })

  it('marks nothing without a signed-in account', () => {
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'everyone'},
      locked: false,
    })
    recordDraftVisibility('draft-1', captureDraftVisibility())
    clearCurrentClients()
    expect(isPrivateDraft('draft-1')).toBe(false)
  })
})

import {type Client} from '@atproto/lex'
import {beforeEach, describe, expect, it} from '@jest/globals'

import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {readLocal, writeLocal} from '#/horizon/session/local-store'
import {
  applyDraftVisibility,
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
    recordDraftVisibility('draft-1')
    expect(readDraftTable(DID)).toEqual([
      {
        id: 'draft-1',
        visibility: 'private',
        audience: {kind: 'list', uri: AUDIENCE},
      },
    ])
    expect(readLocal(`horizon:draft-visibility:${DID}`)).toBeDefined()
  })

  it('saving while Public removes the entry', () => {
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'followers'},
      locked: false,
    })
    recordDraftVisibility('draft-1')
    setComposeVisibility(PUBLIC_COMPOSE)
    recordDraftVisibility('draft-1')
    expect(readDraftTable(DID)).toEqual([])
  })

  it('restoring a draft with an entry makes the compose private with that audience', () => {
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'nobody'},
      locked: false,
    })
    recordDraftVisibility('draft-1')
    setComposeVisibility(PUBLIC_COMPOSE)
    applyDraftVisibility('draft-1')
    expect(getComposeVisibility()).toEqual({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'nobody'},
      locked: false,
    })
  })

  it('restoring a draft without an entry makes the compose public', () => {
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'everyone'},
      locked: false,
    })
    applyDraftVisibility('draft-unknown')
    expect(getComposeVisibility()).toEqual(PUBLIC_COMPOSE)
  })

  it('keeps at most 200 entries, dropping the oldest first', () => {
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'everyone'},
      locked: false,
    })
    for (let i = 0; i < MAX_DRAFT_ENTRIES + 5; i++) {
      recordDraftVisibility(`draft-${i}`)
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
    recordDraftVisibility('a')
    recordDraftVisibility('b')
    recordDraftVisibility('a')
    expect(readDraftTable(DID).map(entry => entry.id)).toEqual(['b', 'a'])
  })

  it('is kept per account', () => {
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'everyone'},
      locked: false,
    })
    recordDraftVisibility('draft-1')
    expect(readDraftTable('did:plc:someoneelseaaaaaaaaaaaaa')).toEqual([])
  })

  it('ignores an unreadable table', () => {
    writeLocal(`horizon:draft-visibility:${DID}`, '{not json')
    expect(readDraftTable(DID)).toEqual([])
  })
})

describe('the drafts list lock (round 2 fix 3)', () => {
  it('marks a draft saved Private, and not one saved Public', () => {
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'followers'},
      locked: false,
    })
    recordDraftVisibility('draft-private')
    setComposeVisibility(PUBLIC_COMPOSE)
    recordDraftVisibility('draft-public')
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
    recordDraftVisibility('draft-1')
    setComposeVisibility(PUBLIC_COMPOSE)
    recordDraftVisibility('draft-1')
    expect(isPrivateDraft('draft-1')).toBe(false)
  })

  it('marks nothing without a signed-in account', () => {
    setComposeVisibility({
      visibility: 'private',
      audience: {kind: 'mode', mode: 'everyone'},
      locked: false,
    })
    recordDraftVisibility('draft-1')
    clearCurrentClients()
    expect(isPrivateDraft('draft-1')).toBe(false)
  })
})

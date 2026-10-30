import {describe, expect, it} from 'vitest'

import {cursorOf, didOfUri, targetsOf} from '../src/events'

const ME = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const YOU = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'
const THEM = 'did:plc:cccccccccccccccccccccccc'
const WEB = 'did:web:example.com'

function create(collection: string, record: unknown, did = ME) {
  return {
    did,
    time_us: 1_700_000_000_000_000,
    kind: 'commit',
    commit: {operation: 'create', collection, rkey: '3k', record},
  }
}

const post = (did: string) => `at://${did}/app.bsky.feed.post/3kabc`

describe('targetsOf', () => {
  it('a like or repost concerns the liked post author', () => {
    expect(targetsOf(create('app.bsky.feed.like', {subject: {uri: post(YOU)}}))).toEqual([YOU])
    expect(targetsOf(create('app.bsky.feed.repost', {subject: {uri: post(WEB)}}))).toEqual([WEB])
  })

  it('a follow concerns the followed account', () => {
    expect(targetsOf(create('app.bsky.graph.follow', {subject: YOU}))).toEqual([YOU])
  })

  it('a reply concerns the parent and root authors', () => {
    const record = {text: 'hi', reply: {parent: {uri: post(YOU)}, root: {uri: post(THEM)}}}
    expect(targetsOf(create('app.bsky.feed.post', record)).sort()).toEqual([YOU, THEM].sort())
  })

  it('a quote concerns the quoted author, with or without media', () => {
    const plain = {embed: {$type: 'app.bsky.embed.record', record: {uri: post(YOU)}}}
    const media = {
      embed: {$type: 'app.bsky.embed.recordWithMedia', record: {record: {uri: post(THEM)}}},
    }
    expect(targetsOf(create('app.bsky.feed.post', plain))).toEqual([YOU])
    expect(targetsOf(create('app.bsky.feed.post', media))).toEqual([THEM])
  })

  it('a mention concerns the mentioned account', () => {
    const record = {
      text: '@you',
      facets: [
        {features: [{$type: 'app.bsky.richtext.facet#mention', did: YOU}]},
        {features: [{$type: 'app.bsky.richtext.facet#link', uri: 'https://example.com'}]},
      ],
    }
    expect(targetsOf(create('app.bsky.feed.post', record))).toEqual([YOU])
  })

  it('never the author themselves, and each account once', () => {
    const record = {
      reply: {parent: {uri: post(ME)}, root: {uri: post(YOU)}},
      facets: [{features: [{$type: 'app.bsky.richtext.facet#mention', did: YOU}]}],
    }
    expect(targetsOf(create('app.bsky.feed.post', record))).toEqual([YOU])
  })

  it('ignores deletes, updates, identity events and junk', () => {
    const like = create('app.bsky.feed.like', {subject: {uri: post(YOU)}})
    expect(targetsOf({...like, commit: {...like.commit, operation: 'delete'}})).toEqual([])
    expect(targetsOf({...like, commit: {...like.commit, operation: 'update'}})).toEqual([])
    expect(targetsOf({did: ME, kind: 'identity'})).toEqual([])
    expect(targetsOf(null)).toEqual([])
    expect(targetsOf(create('app.bsky.graph.follow', {subject: 'not a did'}))).toEqual([])
    expect(targetsOf(create('app.bsky.feed.like', {subject: {uri: 'https://x'}}))).toEqual([])
  })
})

describe('helpers', () => {
  it('didOfUri takes the repo of an at:// URI', () => {
    expect(didOfUri(post(YOU))).toBe(YOU)
    expect(didOfUri(`at://${YOU}`)).toBe(YOU)
    expect(didOfUri('at://handle.example/app.bsky.feed.post/1')).toBeUndefined()
  })

  it('cursorOf reads time_us', () => {
    expect(cursorOf({time_us: 5})).toBe(5)
    expect(cursorOf({time_us: '5'})).toBeUndefined()
  })
})

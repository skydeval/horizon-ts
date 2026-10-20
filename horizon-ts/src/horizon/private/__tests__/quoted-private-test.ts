import {beforeEach, describe, expect, it, jest} from '@jest/globals'

// The suite mocks multiformats globally; CID validation needs the real one.
jest.unmock('multiformats/cid')
jest.unmock('multiformats/hashes/hasher')

let mockMembership = 'member'
jest.mock('#/horizon/routing/membership', () => ({
  getMembership: () => mockMembership,
  reportPrismError: () => {},
  isPrivateMember: (did?: string) => !!did && mockMembership === 'member',
}))
jest.mock('#/state/queries/pds-detection', () => ({
  resolvePdsForIdentifier: (did: string) =>
    Promise.resolve({did, pdsUrl: 'https://pds.example'}),
}))
jest.mock('#/horizon/private/server-support', () =>
  Object.defineProperties(
    {...jest.requireActual<object>('#/horizon/private/server-support')},
    {
      // prism serves facets, so the served ones are converted.
      privateFacetsServed: {value: () => true, enumerable: true},
    },
  ),
)

import {RichText} from '@bsky/sdk/richtext'
import {QueryClient} from '@tanstack/react-query'

import {CW_SELF_LABEL} from '#/horizon/media-spoilers/nsid'
import {
  hasMediaSpoilers,
  mediaSpoilerState,
} from '#/horizon/media-spoilers/read'
import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {detectLocalContentWarningFacets} from '#/horizon/spoilers/content-warning'
import {withContentWarningRecord} from '#/horizon/spoilers/cw-line'
import {buildSpoilerLayout, rendersSpoilers} from '#/horizon/spoilers/layout'
import {detectLocalSpoilerFacets} from '#/horizon/spoilers/local'
import {CONTENT_WARNING_FEATURE, SPOILER_FEATURE} from '#/horizon/spoilers/nsid'
import {app} from '#/lexicons'
import * as bsky from '#/types/bsky'
import {adaptPosts} from '../adapt/feed-view'
import {toPostView, withConvertedQuotes} from '../adapt/post-view'
import {toPrivateFacets} from '../adapt/record'
import {fromQuoteData, privateQuoteQueryKey} from '../quotes/cache'
import {resolvePrivateQuotes} from '../quotes/resolve'
import {toQuoteEmbed} from '../render/quote-embed'
import {clearPrivateStores} from '../store'
import {
  blob,
  type Call,
  DID,
  fakeClient,
  OTHER_DID,
  privateUri,
  RECORD_CID,
  type Reply,
} from './fixtures'
import {
  AUDIENCE_URI,
  fakeAppview,
  PP,
  type PrivateView,
  privateView,
} from './read-fixtures'

const PUB = 'tools.kryphocron.feed.postPublic'
const CW_TEXT = 'cw blood\n||it was a lot||'
const SPOILER_TEXT = 'it ends ||badly||'
const CW_URI = privateUri('3my6s3xv3yk2a', OTHER_DID)
const SPOILER_URI = privateUri('3kspoiler', OTHER_DID)

beforeEach(() => {
  clearPrivateStores()
  clearCurrentClients()
  mockMembership = 'member'
})

function servedFacets(facets: unknown) {
  return toPrivateFacets(facets as app.bsky.richtext.facet.Main[])
}

/** The CW post as prism decodes it: keep-mode text, its facets, the label. */
function cwRecord({withImages = false}: {withImages?: boolean} = {}) {
  return {
    $type: PP,
    text: CW_TEXT,
    createdAt: '2026-10-19T12:00:00.000Z',
    audienceList: AUDIENCE_URI,
    facets: servedFacets(detectLocalContentWarningFacets(CW_TEXT)),
    labels: {$type: `${PUB}#selfLabels`, values: [{val: CW_SELF_LABEL}]},
    ...(withImages
      ? {
          embed: {
            $type: `${PUB}#embedImage`,
            images: [
              {image: blob(), alt: 'one'},
              {image: blob(), alt: 'two'},
            ],
          },
        }
      : {}),
  }
}

/** A post with an inline spoiler, as prism decodes it. */
function spoilerRecord() {
  return {
    $type: PP,
    text: SPOILER_TEXT,
    createdAt: '2026-10-19T12:00:00.000Z',
    audienceList: AUDIENCE_URI,
    facets: servedFacets(detectLocalSpoilerFacets(SPOILER_TEXT)),
  }
}

const imagesView = {
  $type: 'app.bsky.embed.images#view',
  images: [
    {
      thumb: 'https://cdn.example/1',
      fullsize: 'https://cdn.example/1',
      alt: '',
    },
    {
      thumb: 'https://cdn.example/2',
      fullsize: 'https://cdn.example/2',
      alt: '',
    },
  ],
}

/** A quoted private post as prism serves it: `#viewRecord`, value decoded. */
function viewRecord(
  uri: string,
  value: unknown,
  {embeds, labels = []}: {embeds?: unknown[]; labels?: unknown[]} = {},
) {
  return {
    $type: 'app.bsky.embed.record#viewRecord',
    uri,
    cid: RECORD_CID,
    author: {did: OTHER_DID, handle: 'other.test'},
    value,
    labels,
    indexedAt: '2026-10-19T12:00:00.000Z',
    ...(embeds ? {embeds} : {}),
  }
}

function recordView(record: unknown) {
  return {$type: 'app.bsky.embed.record#view', record}
}

/** A private view prism serves with `embed`. */
function quoting(rkey: string, embed: unknown): PrivateView {
  const view = privateView(rkey)
  return {
    ...view,
    record: {
      ...view.record,
      embed: {
        $type: `${PUB}#embedRecord`,
        record: {uri: CW_URI, cid: RECORD_CID},
      },
    },
    embed,
  } as PrivateView
}

type ViewRecord = app.bsky.embed.record.ViewRecord

/** `toPostView` with the embed prism served, as `adaptPosts` passes it. */
function adapt(view: PrivateView) {
  return toPostView(view, {
    embed: (view as PrivateView & {embed: unknown}).embed as NonNullable<
      app.bsky.feed.defs.PostView['embed']
    >,
  })
}

function quoteOf(embed: unknown): ViewRecord {
  const view = embed as {$type: string; record: {record?: unknown}}
  if (view.$type === 'app.bsky.embed.recordWithMedia#view') {
    return view.record.record as ViewRecord
  }
  return view.record as unknown as ViewRecord
}

function featureTypes(record: unknown): string[][] {
  const facets = (record as app.bsky.feed.post.Main).facets ?? []
  return facets.map(facet =>
    facet.features.map(f => (f as {$type: string}).$type),
  )
}

/** The quote's text as `QuoteEmbed` builds it. */
function quoteRichText(quote: ViewRecord) {
  const value = quote.value as app.bsky.feed.post.Main
  return withContentWarningRecord(
    new RichText({text: value.text, facets: value.facets}),
    value,
  )
}

function expectConvertedCw(quote: ViewRecord) {
  expect(quote.value.$type).toBe('app.bsky.feed.post')
  expect(bsky.matches(app.bsky.feed.post, quote.value)).toBe(true)
  expect(featureTypes(quote.value)).toContainEqual(
    expect.arrayContaining([SPOILER_FEATURE, CONTENT_WARNING_FEATURE]),
  )
  expect(quote.value.labels).toEqual({
    $type: 'com.atproto.label.defs#selfLabels',
    values: [{val: CW_SELF_LABEL}],
  })
  expect(quote.labels).toContainEqual(
    expect.objectContaining({
      src: OTHER_DID,
      uri: quote.uri,
      val: CW_SELF_LABEL,
    }),
  )
}

function expectCwLayout(quote: ViewRecord) {
  const layout = buildSpoilerLayout(quoteRichText(quote), {compact: false})
  expect(layout.items[0]).toMatchObject({
    kind: 'run',
    parts: [{kind: 'plain', cwLine: true}],
  })
  const line = layout.items[0].kind === 'run' && layout.items[0].parts[0]
  expect(line && line.richText.text).toBe('cw blood')
  expect(layout.items[1]).toMatchObject({kind: 'drawer', cw: true})
}

describe('a quoted private post in a served embed', () => {
  it('converts the quote: spoiler and #contentWarning facets and the CW label', () => {
    const post = adapt(
      quoting('3kouter', recordView(viewRecord(CW_URI, cwRecord()))),
    )!
    const quote = quoteOf(post.embed)
    expectConvertedCw(quote)
    expectCwLayout(quote)
  })

  it('does not repeat a CW label prism served on the view', () => {
    const served = {
      src: OTHER_DID,
      uri: CW_URI,
      cid: RECORD_CID,
      val: CW_SELF_LABEL,
      cts: '2026-10-19T12:00:00.000Z',
    }
    const post = adapt(
      quoting(
        '3kouter',
        recordView(viewRecord(CW_URI, cwRecord(), {labels: [served]})),
      ),
    )!
    expect(quoteOf(post.embed).labels).toEqual([served])
  })

  it('converts the quote of a quote with media, and covers its own media', () => {
    const embed = {
      $type: 'app.bsky.embed.recordWithMedia#view',
      record: recordView(
        viewRecord(CW_URI, cwRecord({withImages: true}), {
          embeds: [imagesView],
        }),
      ),
      media: imagesView,
    }
    const post = adapt(quoting('3kouter', embed))!
    expect(post.embed?.$type).toBe('app.bsky.embed.recordWithMedia#view')
    const quote = quoteOf(post.embed)
    expectConvertedCw(quote)
    expectCwLayout(quote)
    // The quote's media, as `QuoteEmbed` passes the quote to `Embed`.
    const value = quote.value as app.bsky.feed.post.Main
    expect(value.embed?.$type).toBe('app.bsky.embed.images')
    expect(
      mediaSpoilerState(value, quote.embeds![0] as app.bsky.embed.images.View),
    ).toEqual({flags: [true, true], contentWarning: true})
    expect(hasMediaSpoilers({record: value, embed: quote.embeds![0]})).toBe(
      true,
    )
  })

  it('converts a quote inside the quote (its embeds)', () => {
    const inner = viewRecord(SPOILER_URI, spoilerRecord())
    const embed = recordView(
      viewRecord(CW_URI, cwRecord(), {embeds: [recordView(inner)]}),
    )
    const post = adapt(quoting('3kouter', embed))!
    const quote = quoteOf(post.embed)
    expectConvertedCw(quote)
    const nested = quoteOf(quote.embeds![0])
    expect(nested.value.$type).toBe('app.bsky.feed.post')
    expect(featureTypes(nested.value).flat()).toContain(SPOILER_FEATURE)
    const richText = quoteRichText(nested)
    expect(rendersSpoilers(richText)).toBe(true)
    const layout = buildSpoilerLayout(richText, {compact: false})
    const parts = layout.items.flatMap(item =>
      item.kind === 'run' ? item.parts : item.parts,
    )
    expect(parts).toContainEqual(
      expect.objectContaining({
        kind: 'spoiler',
        richText: expect.objectContaining({text: 'badly'}),
      }),
    )
  })

  it('leaves a public quote and its identity alone', () => {
    const publicQuote = recordView(
      viewRecord('at://did:plc:a/app.bsky.feed.post/3kpub', {
        $type: 'app.bsky.feed.post',
        text: 'public',
        createdAt: '2026-10-19T12:00:00.000Z',
      }),
    ) as unknown as NonNullable<app.bsky.feed.defs.PostView['embed']>
    expect(withConvertedQuotes(publicQuote)).toBe(publicQuote)
  })

  it('is converted on the batch path (feed, thread, notifications, Saved)', async () => {
    const appview = fakeAppview()
    const view = quoting('3kouter', recordView(viewRecord(CW_URI, cwRecord())))
    const {views} = await adaptPosts([{view}], appview.client, () => undefined)
    expectConvertedCw(quoteOf(views.get(view.uri)!.embed))
  })
})

describe('a quoted private post Horizon resolves', () => {
  function setup(posts: PrivateView[]) {
    const prism = fakeClient(DID, (call: Call): Reply => {
      if (call.nsid !== 'app.nearhorizon.private.getPosts') {
        return {status: 501, body: {error: 'MethodNotImplemented'}}
      }
      const wanted = call.params.getAll('uris')
      return {
        status: 200,
        body: {posts: posts.filter(p => wanted.includes(p.uri))},
      }
    })
    const appview = fakeAppview()
    const queryClient = new QueryClient({
      defaultOptions: {queries: {retry: false}},
    })
    publishCurrentClients({
      did: DID,
      handle: 'me.test',
      pdsUrl: undefined,
      pdsClient: {} as never,
      prismClient: prism.client,
      appviewClient: appview.client,
      queryClient,
    })
    const context = {
      clients: {
        did: DID,
        prismClient: prism.client,
        appviewClient: appview.client,
      },
      queryClient,
    }
    return {queryClient, context}
  }

  /** A public post quoting `uri`, which the public AppView cannot hydrate. */
  function publicQuoting(uri: string): app.bsky.feed.defs.PostView {
    return {
      $type: 'app.bsky.feed.defs#postView',
      uri: 'at://did:plc:publicc/app.bsky.feed.post/3kpub',
      cid: RECORD_CID,
      author: {did: 'did:plc:publicc', handle: 'pub.test'},
      record: {$type: 'app.bsky.feed.post', text: 'pub', createdAt: '2026'},
      indexedAt: '2026-10-19T00:00:00.000Z',
      embed: {
        $type: 'app.bsky.embed.record#view',
        record: {
          $type: 'app.bsky.embed.record#viewNotFound',
          uri,
          notFound: true,
        },
      },
    } as unknown as app.bsky.feed.defs.PostView
  }

  it('gives the quote renderer the CW post converted, with its CW label', async () => {
    const cw = {
      ...privateView('3my6s3xv3yk2a', {did: OTHER_DID}),
      record: cwRecord(),
    } as PrivateView
    const {queryClient, context} = setup([cw])
    await resolvePrivateQuotes([publicQuoting(CW_URI)], context)
    const cached = fromQuoteData(
      queryClient.getQueryData(privateQuoteQueryKey(CW_URI)),
    )!
    const quote = toQuoteEmbed(cached).view
    expectConvertedCw(quote)
    expectCwLayout(quote)
  })

  it('converts a resolved quote that quotes a private CW post itself', async () => {
    const outer = {
      ...quoting('3kouter', recordView(viewRecord(CW_URI, cwRecord()))),
      uri: privateUri('3kouter', OTHER_DID),
      author: {did: OTHER_DID, handle: 'other.test'},
    } as PrivateView
    const {queryClient, context} = setup([outer])
    await resolvePrivateQuotes([publicQuoting(outer.uri)], context)
    const cached = fromQuoteData(
      queryClient.getQueryData(privateQuoteQueryKey(outer.uri)),
    )!
    const quote = toQuoteEmbed(cached).view
    expect(quote.value.$type).toBe('app.bsky.feed.post')
    const nested = quoteOf(quote.embeds![0])
    expectConvertedCw(nested)
    expectCwLayout(nested)
  })
})

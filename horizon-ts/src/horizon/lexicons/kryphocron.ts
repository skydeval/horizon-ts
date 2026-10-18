/*
 * Hand-written schemas for the kryphocron procedures aurora-locus serves and
 * the two kryphocron records Horizon writes. No lexicon file exists for the
 * procedures yet (dependency K-5), so they follow aurora's handlers: a
 * create-shaped input `{repo, rkey?, validate?, record}` with output
 * `{uri, cid}`, whose `cid` the create path does not read (it reads the
 * stored CID back with `getRecord`); a delete-shaped input `{repo, rkey}`
 * with output `{}`; and `updatePostPrivate`, whose answer's `cid` is the
 * record's (A-1).
 *
 * The records follow `tools.kryphocron.feed.postPrivate`,
 * `tools.kryphocron.feed.postPublic` (its embed, facet and strong-ref defs,
 * as kryphocron-lexicons 0.3.1 defines them)
 * and `tools.kryphocron.policy.audience`. The encoded-content fields of
 * `postPrivate` are left out: the client never sends them.
 *
 * When kryphocron publishes lexicon files for the procedures, generated
 * schemas replace this file.
 */

import {l} from '@atproto/lex'

import {contentWarning, spoiler, spoilerMarker} from './richtext'

const POST_PUBLIC = 'tools.kryphocron.feed.postPublic'

/**
 * `tools.kryphocron.feed.postPublic#strongRef`.
 */
export const strongRef = l.object({
  uri: l.string({format: 'at-uri'}),
  cid: l.string({format: 'cid'}),
})

/**
 * `tools.kryphocron.feed.postPublic#replyRef`.
 */
export const replyRef = l.object({
  root: strongRef,
  parent: strongRef,
})

/**
 * `tools.kryphocron.feed.postPublic#aspectRatio` (K-4).
 */
export const aspectRatio = l.object({
  width: l.integer({minimum: 1}),
  height: l.integer({minimum: 1}),
})

/**
 * Horizon's per-item media spoiler flag (2J design, 3.1), written only as
 * `true`. Listed so a value of another type fails validation; the lexicon's
 * objects are open, so other readers keep or ignore it.
 */
const mediaSpoilerFlag = l.optional(l.boolean())

const image = l.object({
  image: l.blob({accept: ['image/*'], maxSize: 2_000_000}),
  alt: l.string(),
  aspectRatio: l.optional(aspectRatio),
  'app.nearhorizon.spoiler': mediaSpoilerFlag,
})

/**
 * `tools.kryphocron.feed.postPublic#embedImage`: up to four images with alt
 * text. `aspectRatio` is written only once `PRIVATE_MEDIA_EXTRAS` is on.
 */
export const embedImage = l.typedObject(
  POST_PUBLIC,
  'embedImage',
  l.object({images: l.array(image, {maxLength: 4})}),
)

/**
 * `tools.kryphocron.feed.postPublic#embedExternal`: a link card. `thumb` is
 * written only once `PRIVATE_MEDIA_EXTRAS` is on.
 */
export const embedExternal = l.typedObject(
  POST_PUBLIC,
  'embedExternal',
  l.object({
    external: l.object({
      uri: l.string({format: 'uri'}),
      title: l.string(),
      description: l.string(),
      thumb: l.optional(l.blob({accept: ['image/*'], maxSize: 1_000_000})),
    }),
  }),
)

/**
 * `tools.kryphocron.feed.postPublic#galleryImage` (K-7): `aspectRatio` is
 * required on every item.
 */
export const galleryImage = l.typedObject(
  POST_PUBLIC,
  'galleryImage',
  l.object({
    image: l.blob({accept: ['image/*'], maxSize: 2_000_000}),
    alt: l.string(),
    aspectRatio,
    'app.nearhorizon.spoiler': mediaSpoilerFlag,
  }),
)

/**
 * `tools.kryphocron.feed.postPublic#embedGallery` (K-7): up to 20 items;
 * the composer makes at most 10.
 */
export const embedGallery = l.typedObject(
  POST_PUBLIC,
  'embedGallery',
  l.object({
    items: l.array(l.typedUnion([l.typedRef(() => galleryImage)], true), {
      maxLength: 20,
    }),
  }),
)

const caption = l.object({
  lang: l.string({format: 'language'}),
  file: l.blob({accept: ['text/vtt'], maxSize: 20_000}),
})

/**
 * `tools.kryphocron.feed.postPublic#embedVideo` (K-6): the stock video
 * embed's fields under the kryphocron name.
 */
export const embedVideo = l.typedObject(
  POST_PUBLIC,
  'embedVideo',
  l.object({
    video: l.blob({accept: ['video/mp4'], maxSize: 300_000_000}),
    captions: l.optional(l.array(caption, {maxLength: 20})),
    alt: l.optional(l.string()),
    aspectRatio: l.optional(aspectRatio),
    presentation: l.optional(l.string()),
    'app.nearhorizon.spoiler': mediaSpoilerFlag,
  }),
)

/**
 * `tools.kryphocron.feed.postPublic#embedRecord`: a quote.
 */
export const embedRecord = l.typedObject(
  POST_PUBLIC,
  'embedRecord',
  l.object({record: strongRef}),
)

/**
 * `tools.kryphocron.feed.postPublic#embedRecordWithMedia` (K-2): a quote and
 * images, a gallery, a video or a link card.
 */
export const embedRecordWithMedia = l.typedObject(
  POST_PUBLIC,
  'embedRecordWithMedia',
  l.object({
    record: l.object({record: strongRef}),
    media: l.typedUnion(
      [
        l.typedRef(() => embedImage),
        l.typedRef(() => embedGallery),
        l.typedRef(() => embedVideo),
        l.typedRef(() => embedExternal),
      ],
      true,
    ),
  }),
)

/**
 * `tools.kryphocron.feed.postPublic#mention`.
 */
export const mention = l.typedObject(
  POST_PUBLIC,
  'mention',
  l.object({did: l.string({format: 'did'})}),
)

/**
 * `tools.kryphocron.feed.postPublic#link`.
 */
export const link = l.typedObject(
  POST_PUBLIC,
  'link',
  l.object({uri: l.string({format: 'uri'})}),
)

/**
 * `tools.kryphocron.feed.postPublic#tag`.
 */
export const tag = l.typedObject(
  POST_PUBLIC,
  'tag',
  l.object({tag: l.string({maxGraphemes: 64, maxLength: 640})}),
)

/**
 * `tools.kryphocron.feed.postPublic#facet`. The lexicon's feature union is
 * open; this one is closed and lists, beside kryphocron's own features,
 * Horizon's spoiler and content warning features
 * (`app.nearhorizon.richtext.facet`), so a private record carries only
 * features Horizon writes.
 */
export const facet = l.typedObject(
  POST_PUBLIC,
  'facet',
  l.object({
    index: l.object({
      byteStart: l.integer({minimum: 0}),
      byteEnd: l.integer({minimum: 0}),
    }),
    features: l.array(
      l.typedUnion(
        [
          l.typedRef(() => mention),
          l.typedRef(() => link),
          l.typedRef(() => tag),
          l.typedRef(() => spoiler),
          l.typedRef(() => spoilerMarker),
          l.typedRef(() => contentWarning),
        ],
        true,
      ),
    ),
  }),
)

/**
 * `tools.kryphocron.feed.postPublic#selfLabel`.
 */
export const selfLabel = l.object({val: l.string({maxLength: 128})})

/**
 * `tools.kryphocron.feed.postPublic#selfLabels` (K-1): the author's content
 * labels. Written once `PRIVATE_LANGS_LABELS` is on.
 */
export const selfLabels = l.typedObject(
  POST_PUBLIC,
  'selfLabels',
  l.object({values: l.array(selfLabel, {maxLength: 10})}),
)

/**
 * `tools.kryphocron.feed.postPrivate`, as Horizon writes it. `text` is
 * optional in the lexicon; Horizon always writes it (see
 * `private/api/validate.ts`). `langs` and `labels` (K-1) are written once
 * `PRIVATE_LANGS_LABELS` is on.
 */
export const postPrivate = l.record(
  'tid',
  'tools.kryphocron.feed.postPrivate',
  l.object({
    text: l.string({maxGraphemes: 300, maxLength: 3000}),
    createdAt: l.string({format: 'datetime'}),
    audienceList: l.string({format: 'at-uri'}),
    reply: l.optional(replyRef),
    embed: l.optional(
      l.typedUnion(
        [
          l.typedRef(() => embedImage),
          l.typedRef(() => embedExternal),
          l.typedRef(() => embedRecord),
          l.typedRef(() => embedGallery),
          l.typedRef(() => embedVideo),
          l.typedRef(() => embedRecordWithMedia),
        ],
        true,
      ),
    ),
    facets: l.optional(l.array(facet)),
    langs: l.optional(l.array(l.string({format: 'language'}), {maxLength: 3})),
    labels: l.optional(l.typedUnion([l.typedRef(() => selfLabels)], true)),
  }),
)

export type PostPrivate = l.InferOutput<typeof postPrivate>
export type PostPrivateEmbed = NonNullable<PostPrivate['embed']>
export type PostPrivateFacet = NonNullable<PostPrivate['facets']>[number]
export type StrongRef = l.InferOutput<typeof strongRef>

/**
 * `tools.kryphocron.policy.audience`. `mode` absent reads as `list`; aurora's
 * signup default writes neither timestamp, so reads must not rely on them.
 */
export const audience = l.record(
  'tid',
  'tools.kryphocron.policy.audience',
  l.object({
    name: l.optional(l.string({maxGraphemes: 64, maxLength: 640})),
    mode: l.optional(l.string()),
    members: l.optional(l.array(l.string({format: 'did'}))),
    createdAt: l.string({format: 'datetime'}),
    updatedAt: l.string({format: 'datetime'}),
  }),
)

export type Audience = l.InferOutput<typeof audience>

const createInput = l.jsonPayload({
  repo: l.string({format: 'did'}),
  rkey: l.optional(l.string()),
  validate: l.optional(l.boolean()),
  record: l.lexMap(),
})

const createOutput = l.jsonPayload({
  uri: l.string({format: 'at-uri'}),
  /** The commit's CID, not the record's. No Horizon code reads it. */
  cid: l.string(),
})

const deleteInput = l.jsonPayload({
  repo: l.string({format: 'did'}),
  rkey: l.string(),
})

/**
 * `tools.kryphocron.feed.createPostPrivate`: a private post under one of the
 * writer's own audiences.
 */
export const createPostPrivate = l.procedure(
  'tools.kryphocron.feed.createPostPrivate',
  l.params(),
  createInput,
  createOutput,
)

/**
 * `tools.kryphocron.actor.participatePrivate`: a private reply under another
 * account's audience.
 */
export const participatePrivate = l.procedure(
  'tools.kryphocron.actor.participatePrivate',
  l.params(),
  createInput,
  createOutput,
)

/**
 * `tools.kryphocron.feed.deletePostPrivate`.
 */
export const deletePostPrivate = l.procedure(
  'tools.kryphocron.feed.deletePostPrivate',
  l.params(),
  deleteInput,
  l.jsonPayload({}),
)

/**
 * `tools.kryphocron.feed.updatePostPrivate` (aurora A-9, kryphocron-lexicons
 * 0.3.1): sets a private post's `audienceList` in place and keeps every other
 * field. Answers the new record CID (A-1); a `swapRecord` that is not the
 * post's current CID gets 409 `InvalidSwap`. aurora accepts a top-level post
 * or a branch root (a post whose `reply.parent` is not private, A-13).
 */
export const updatePostPrivate = l.procedure(
  'tools.kryphocron.feed.updatePostPrivate',
  l.params(),
  l.jsonPayload({
    repo: l.string({format: 'did'}),
    rkey: l.string(),
    audienceList: l.string({format: 'at-uri'}),
    swapRecord: l.optional(l.string({format: 'cid'})),
  }),
  l.jsonPayload({
    uri: l.string({format: 'at-uri'}),
    /** The updated record's CID (A-1). */
    cid: l.string(),
  }),
)

/**
 * `tools.kryphocron.policy.manageAudience`: creates an audience record. It
 * honours a supplied rkey; Horizon never passes one.
 */
export const manageAudience = l.procedure(
  'tools.kryphocron.policy.manageAudience',
  l.params(),
  createInput,
  createOutput,
)

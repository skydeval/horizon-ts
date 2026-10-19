/*
 * `app.nearhorizon.actor.postingDefaults` (Phase 3, batch B): how a new post
 * starts in the composer, written by hand in the stock generated record
 * shape. One per account, rkey `self`, in the account's own repo, so only the
 * account itself can write it; Horizon reads it only from the signed-in
 * account's own repo. Public like any repo record (private posting is
 * friction, not secrecy).
 *
 * `private` holds the private posting defaults: whether a new post starts
 * Public or Private, and the audience a private post starts with (a standing
 * mode, or one of the account's own list audiences). The public reply and
 * quote defaults are not here: they stay Bluesky's preferences
 * (`postInteractionSettings`), which private posts share.
 *
 * The schema types writes and is used by tests; reads parse leniently
 * (`private/defaults/record.ts`), so one bad field never loses the others,
 * and unknown fields are kept on write.
 */

import {l} from '@atproto/lex'
import {type AtUriString} from '@atproto/syntax'

export const POSTING_DEFAULTS_COLLECTION =
  'app.nearhorizon.actor.postingDefaults'
export const POSTING_DEFAULTS_RKEY = 'self'

/** `#audience`: a standing mode, or `list` with the list audience's URI. */
export type DefaultAudienceRecord = {
  mode:
    'everyone' | 'followers' | 'following' | 'nobody' | 'list' | l.UnknownString
  /** With `list`: one of the account's own `tools.kryphocron.policy.audience` records. */
  list?: AtUriString
}

/** `#privateDefaults`. */
export type PrivateDefaultsRecord = {
  startAs: 'public' | 'private' | l.UnknownString
  audience?: DefaultAudienceRecord
}

/** The record, as written. */
export type PostingDefaultsRecord = {
  $type: 'app.nearhorizon.actor.postingDefaults'
  version: number
  private?: PrivateDefaultsRecord
  updatedAt: l.DatetimeString
}

const audience = l.object({
  mode: l.string<{
    knownValues: ['everyone', 'followers', 'following', 'nobody', 'list']
  }>(),
  list: l.optional(l.string({format: 'at-uri'})),
})

const privateDefaults = l.object({
  startAs: l.string<{knownValues: ['public', 'private']}>(),
  audience: l.optional(audience),
})

export const postingDefaultsRecord = l.record<
  'literal:self',
  PostingDefaultsRecord
>(
  'literal:self',
  POSTING_DEFAULTS_COLLECTION,
  l.object({
    version: l.integer({minimum: 1}),
    private: l.optional(privateDefaults),
    updatedAt: l.string({format: 'datetime'}),
  }),
)

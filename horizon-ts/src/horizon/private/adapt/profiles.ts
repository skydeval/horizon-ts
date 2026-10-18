/*
 * The author merge (6.1.1). prism's `author` is a `profileViewBasic` whose
 * `viewer` state (muted, blocking, following) may be absent, and moderation,
 * mutes and the feed tuners need it. Each adapter batch therefore asks the
 * public AppView the user chose for the profiles of the batch's authors and
 * uses the public profile in place of prism's; a DID the AppView does not
 * return (or a failed call) keeps prism's profile as it is.
 */

import {type Client} from '@atproto/lex'
import {type AtIdentifierString} from '@atproto/syntax'

import {logger} from '#/logger'
import {app} from '#/lexicons'

const GET_PROFILES_BATCH = 25

/**
 * The basic fields of a public profile, as a post's author carries them.
 */
export function toProfileViewBasic(
  profile: app.bsky.actor.defs.ProfileViewDetailed,
): app.bsky.actor.defs.ProfileViewBasic {
  const basic: app.bsky.actor.defs.ProfileViewBasic = {
    $type: 'app.bsky.actor.defs#profileViewBasic',
    did: profile.did,
    handle: profile.handle,
  }
  if (profile.displayName !== undefined) basic.displayName = profile.displayName
  if (profile.avatar !== undefined) basic.avatar = profile.avatar
  if (profile.associated !== undefined) basic.associated = profile.associated
  if (profile.viewer !== undefined) basic.viewer = profile.viewer
  if (profile.labels !== undefined) basic.labels = profile.labels
  if (profile.createdAt !== undefined) basic.createdAt = profile.createdAt
  if (profile.verification !== undefined) {
    basic.verification = profile.verification
  }
  if (profile.status !== undefined) basic.status = profile.status
  if (profile.pronouns !== undefined) basic.pronouns = profile.pronouns
  return basic
}

/**
 * The public profiles of `dids`, asked 25 at a time. A DID the AppView does
 * not return, or one whose batch failed, is absent from the map.
 */
export async function fetchPublicAuthors(
  appview: Client,
  dids: Iterable<string>,
): Promise<Map<string, app.bsky.actor.defs.ProfileViewBasic>> {
  const unique = Array.from(new Set(dids))
  const found = new Map<string, app.bsky.actor.defs.ProfileViewBasic>()
  const batches: string[][] = []
  for (let i = 0; i < unique.length; i += GET_PROFILES_BATCH) {
    batches.push(unique.slice(i, i + GET_PROFILES_BATCH))
  }
  await Promise.all(
    batches.map(async batch => {
      try {
        const res = await appview.call(app.bsky.actor.getProfiles, {
          actors: batch as AtIdentifierString[],
        })
        for (const profile of res.profiles) {
          found.set(profile.did, toProfileViewBasic(profile))
        }
      } catch (error) {
        logger.warn('private post authors: public profiles unavailable', {
          safeMessage: error,
        })
      }
    }),
  )
  return found
}

/**
 * The author to show: the public profile when the AppView returned one,
 * else prism's.
 */
export function mergeAuthor(
  prismAuthor: app.bsky.actor.defs.ProfileViewBasic,
  publicAuthors: Map<string, app.bsky.actor.defs.ProfileViewBasic>,
): app.bsky.actor.defs.ProfileViewBasic {
  return publicAuthors.get(prismAuthor.did) ?? prismAuthor
}

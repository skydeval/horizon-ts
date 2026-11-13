/*
 * Reporting a kryphocron post.
 *
 * The report is the stock `com.atproto.moderation.createReport`, through the
 * user's PDS to a labeler's public DID, with the post's strongRef as subject.
 * What differs is who may receive it: only a labeler that can read the post.
 * Bluesky's moderation service cannot, so it is never offered, and the reasons
 * that normally go only to Bluesky go to the labelers that remain. A
 * kryphocron labeler is never sent a report directly; the public labeler it
 * belongs to routes kryphocron subjects to it.
 */

import {AtUri} from '@atproto/syntax'

import {isKryphocronLabeler} from '#/horizon/kryphocron-labelers'
import {isPrivatePostUri} from '#/horizon/private/uri'

/**
 * The record collection a post report names: the post URI's own collection,
 * which for a kryphocron post is not `app.bsky.feed.post`.
 */
export function reportPostCollection(uri: string): string {
  if (!isPrivatePostUri(uri)) return 'app.bsky.feed.post'
  return new AtUri(uri).collection
}

/**
 * Whether a report subject is a kryphocron record (by its collection).
 */
export function isKryphocronReportSubject(nsid: string | undefined): boolean {
  return !!nsid && nsid.startsWith('tools.kryphocron.')
}

/**
 * Whether a moderation inbox report's subject is a kryphocron record (its
 * URI's collection).
 */
export function isKryphocronReport(report: {subject: object}): boolean {
  const subject = report.subject as {uri?: unknown}
  if (typeof subject.uri !== 'string') return false
  return isKryphocronReportSubject(subject.uri.split('/')[3])
}

/**
 * Whether the labeler `did`, declaring `collections` (absent when it accepts
 * any record), may be offered a report on the kryphocron record `nsid`.
 * `bskyModerationDid` is Bluesky's moderation service.
 */
export function canReceiveKryphocronReport({
  did,
  collections,
  nsid,
  bskyModerationDid,
}: {
  did: string
  collections: string[] | undefined
  nsid: string
  bskyModerationDid: string
}): boolean {
  if (did === bskyModerationDid) return false
  if (isKryphocronLabeler(did)) return false
  return collections === undefined || collections.includes(nsid)
}

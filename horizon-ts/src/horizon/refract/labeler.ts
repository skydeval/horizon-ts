/*
 * C-8, the community labeler on restored views (refract client design 6,
 * RF-B9). skydeval decided on 2026-10-23: "show community labels to everyone
 * who is a horizon member".
 *
 * - For a Horizon member, a view whose readable marker carries `labeler` is
 *   moderated with that labeler added for that view only, whether or not the
 *   reader subscribes: `prefs.labelers` gains `{did: labeler, labels: {}}`
 *   (so the labeler's defaults apply) and `labelDefs[labeler]` its
 *   definitions, from `app.bsky.labeler.getServices({dids, detailed: true})`
 *   on the stock AppView, cached for an hour.
 * - A reader who already subscribes gets nothing added.
 * - Until the definitions arrive the view is moderated as stock would, never
 *   held back; their arrival bumps {@link communityLabelerVersion}, which the
 *   moderation options provider reads, so every consumer moderates again.
 * - A non-member keeps stock behaviour: the labels count only for readers who
 *   subscribe to that labeler.
 *
 * Visitor viewer state (RF-S12, Q7) is not read here.
 */

import {useSyncExternalStore} from 'react'
import {type DidString} from '@atproto/syntax'
import {
  type InterpretedLabelValueDefinition,
  interpretLabelValueDefinitions,
  type ModerationOpts,
} from '@bsky/sdk/moderation'

import {logger} from '#/logger'
import {readRestored} from '#/horizon/refract/marker'
import {
  getCurrentAppviewClient,
  getCurrentDid,
} from '#/horizon/routing/current-clients'
import {getMembership, subscribeMembership} from '#/horizon/routing/membership'
import {REFRACT, REFRACT_COMMUNITY_LABELER} from '#/horizon/switches'
import {app} from '#/lexicons'

type LabelerViewDetailed = app.bsky.labeler.defs.LabelerViewDetailed

/** How long a labeler's definitions are kept (design 6). */
export const COMMUNITY_LABELER_TTL_MS = 60 * 60_000
/** How long a failed definitions fetch waits before it is asked again. */
export const COMMUNITY_LABELER_RETRY_MS = 5 * 60_000

type Entry = {
  defs: InterpretedLabelValueDefinition[]
  view: LabelerViewDetailed
  at: number
}

const entries = new Map<string, Entry>()
const failedAt = new Map<string, number>()
const inFlight = new Set<string>()
const queued = new Set<string>()
let flushScheduled = false
const listeners = new Set<() => void>()
let version = 0
/** Extended options, per base options object and labeler, for stable identity. */
let extended = new WeakMap<ModerationOpts, Map<string, ModerationOpts>>()

function notify() {
  version++
  extended = new WeakMap()
  listeners.forEach(listener => listener())
}

/**
 * Whether the community labeler applies for `did` (default: the signed-in
 * account): the switch on and the account a Horizon member.
 */
export function communityLabelerOn(
  did: string | undefined = getCurrentDid(),
): boolean {
  if (!REFRACT || !REFRACT_COMMUNITY_LABELER || !did) return false
  return getMembership(did) === 'member'
}

function fresh(did: string, now: number): Entry | undefined {
  const entry = entries.get(did)
  return entry && now - entry.at < COMMUNITY_LABELER_TTL_MS ? entry : undefined
}

async function flush() {
  flushScheduled = false
  const dids = Array.from(queued)
  queued.clear()
  if (dids.length === 0) return
  const client = getCurrentAppviewClient()
  if (!client) return
  dids.forEach(did => inFlight.add(did))
  try {
    const res = await client.call(app.bsky.labeler.getServices, {
      dids: dids as DidString[],
      detailed: true,
    })
    const now = Date.now()
    for (const view of res.views as LabelerViewDetailed[]) {
      const did = view?.creator?.did
      if (typeof did !== 'string' || !dids.includes(did)) continue
      entries.set(did, {
        defs: interpretLabelValueDefinitions(view),
        view,
        at: now,
      })
      failedAt.delete(did)
    }
    for (const did of dids) {
      if (!entries.has(did) || entries.get(did)!.at !== now) {
        failedAt.set(did, now)
      }
    }
  } catch (error) {
    const now = Date.now()
    dids.forEach(did => failedAt.set(did, now))
    logger.warn('refract: community labeler definitions failed', {
      safeMessage: error,
    })
  } finally {
    dids.forEach(did => inFlight.delete(did))
    notify()
  }
}

/**
 * Ask for `labeler`'s definitions in the background, unless they are fresh,
 * already asked for, or failed in the last {@link COMMUNITY_LABELER_RETRY_MS}.
 * Asks made in the same tick share one `getServices`.
 */
export function requestCommunityLabeler(labeler: string) {
  const now = Date.now()
  if (fresh(labeler, now) || inFlight.has(labeler) || queued.has(labeler)) {
    return
  }
  const failed = failedAt.get(labeler)
  if (failed !== undefined && now - failed < COMMUNITY_LABELER_RETRY_MS) return
  queued.add(labeler)
  if (flushScheduled) return
  flushScheduled = true
  void Promise.resolve().then(flush)
}

/**
 * The moderation options for `view` (design 6, `restoredModerationOpts`):
 * `opts` itself unless the reader is a member, `view` carries a readable
 * marker with `labeler`, the reader doesn't already subscribe to it, and its
 * definitions are in hand. Then the options with that labeler added, the
 * same object for the same `opts` and labeler until the definitions change.
 */
export function restoredModerationOpts<T extends ModerationOpts | undefined>(
  opts: T,
  view: unknown,
): T {
  if (!opts || !communityLabelerOn(opts.userDid ?? undefined)) return opts
  const labeler = readRestored(view)?.labeler
  if (!labeler) return opts
  if (opts.prefs.labelers.some(entry => entry.did === labeler)) return opts
  const entry = fresh(labeler, Date.now())
  if (!entry) {
    requestCommunityLabeler(labeler)
    // A stale entry is still used while it is asked again.
    const stale = entries.get(labeler)
    if (!stale) return opts
    return withLabeler(opts, labeler, stale)
  }
  return withLabeler(opts, labeler, entry)
}

function withLabeler<T extends ModerationOpts>(
  opts: T,
  labeler: string,
  entry: Entry,
): T {
  let byLabeler = extended.get(opts)
  if (!byLabeler) {
    byLabeler = new Map()
    extended.set(opts, byLabeler)
  }
  const held = byLabeler.get(labeler)
  if (held) return held as T
  const next = {
    ...opts,
    prefs: {
      ...opts.prefs,
      labelers: [
        ...opts.prefs.labelers,
        {did: labeler as DidString, labels: {}},
      ],
    },
    labelDefs: {...opts.labelDefs, [labeler]: entry.defs},
  } as T
  byLabeler.set(labeler, next)
  return next
}

/**
 * The definitions and views of every community labeler in hand, for the
 * label names and "Labeled by" lines, when the community labeler applies for
 * the signed-in account. The definitions only count where a view adds its
 * labeler (above); stock moderation skips labelers the reader doesn't use.
 */
export function communityLabelInfo(): {
  labelDefs: Record<string, InterpretedLabelValueDefinition[]>
  labelers: LabelerViewDetailed[]
} {
  if (!communityLabelerOn()) return {labelDefs: {}, labelers: []}
  const labelDefs: Record<string, InterpretedLabelValueDefinition[]> = {}
  const labelers: LabelerViewDetailed[] = []
  for (const [did, entry] of entries) {
    labelDefs[did] = entry.defs
    labelers.push(entry.view)
  }
  return {labelDefs, labelers}
}

/** Changes whenever definitions arrive or membership changes. */
export function communityLabelerVersion(): string {
  return `${version}:${communityLabelerOn() ? 1 : 0}`
}

/** Called when definitions arrive. Returns the unsubscribe function. */
export function subscribeCommunityLabeler(listener: () => void) {
  listeners.add(listener)
  const unsubscribe = subscribeMembership(listener)
  return () => {
    listeners.delete(listener)
    unsubscribe()
  }
}

/**
 * {@link communityLabelerVersion}, re-rendering on change: the moderation
 * options provider reads it so its consumers moderate again.
 */
export function useCommunityLabelerVersion(): string {
  return useSyncExternalStore(
    subscribeCommunityLabeler,
    communityLabelerVersion,
  )
}

/** Tests: forget every definition and ask. */
export function resetCommunityLabeler() {
  entries.clear()
  failedAt.clear()
  inFlight.clear()
  queued.clear()
  flushScheduled = false
  notify()
}

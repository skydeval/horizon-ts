/*
 * The draft visibility table. Bluesky's drafts are stored on the public
 * AppView and have no field for visibility, so Horizon remembers, per account
 * and by draft id, which drafts were saved Private and with which audience,
 * so a draft saved Private comes back Private. It is never widened to Public
 * or Everyone on its own.
 */

import {logger} from '#/logger'
import {
  type ComposeAudience,
  getComposeVisibility,
  PUBLIC_COMPOSE,
  setComposeVisibility,
} from '#/horizon/private/composer/state'
import {getCurrentDid} from '#/horizon/routing/current-clients'
import {readLocal, writeLocal} from '#/horizon/session/local-store'
import {PRIVATE_POSTING} from '#/horizon/switches'

/**
 * At most this many entries per account; the oldest are dropped first.
 */
export const MAX_DRAFT_ENTRIES = 200

type DraftAudience = Exclude<ComposeAudience, {kind: 'parent'}>

type DraftEntry = {
  id: string
  visibility: 'private'
  audience: DraftAudience
}

function tableKey(did: string) {
  return `horizon:draft-visibility:${did}`
}

function isDraftAudience(value: unknown): value is DraftAudience {
  if (typeof value !== 'object' || value === null) return false
  const audience = value as Record<string, unknown>
  if (audience.kind === 'mode') {
    return (
      audience.mode === 'everyone' ||
      audience.mode === 'followers' ||
      audience.mode === 'following' ||
      audience.mode === 'nobody'
    )
  }
  return audience.kind === 'list' && typeof audience.uri === 'string'
}

/**
 * The account's table, oldest entry first.
 */
export function readDraftTable(did: string): DraftEntry[] {
  const raw = readLocal(tableKey(did))
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return (parsed as unknown[]).filter((entry): entry is DraftEntry => {
      if (typeof entry !== 'object' || entry === null) return false
      const candidate = entry as Record<string, unknown>
      return (
        typeof candidate.id === 'string' &&
        candidate.visibility === 'private' &&
        isDraftAudience(candidate.audience)
      )
    })
  } catch (e) {
    logger.warn('draft visibility table unreadable; starting over', {
      message: e instanceof Error ? e.message : String(e),
    })
    return []
  }
}

function writeDraftTable(did: string, entries: DraftEntry[]) {
  const kept = entries.slice(-MAX_DRAFT_ENTRIES)
  writeLocal(tableKey(did), kept.length ? JSON.stringify(kept) : undefined)
}

/**
 * Called after every draft save, once the draft id is known: records the
 * compose's visibility and audience for that id, or removes the entry when
 * the compose is public.
 */
export function recordDraftVisibility(draftId: string) {
  const did = getCurrentDid()
  if (!PRIVATE_POSTING || !did) return
  const current = getComposeVisibility()
  const others = readDraftTable(did).filter(entry => entry.id !== draftId)
  if (current.visibility === 'public' || current.audience.kind === 'parent') {
    writeDraftTable(did, others)
    return
  }
  writeDraftTable(did, [
    ...others,
    {id: draftId, visibility: 'private', audience: current.audience},
  ])
}

/**
 * Called after a draft is restored into the composer: with an entry, the
 * compose becomes Private with that audience; without one, Public with
 * Everyone.
 */
export function applyDraftVisibility(draftId: string) {
  const did = getCurrentDid()
  if (!PRIVATE_POSTING || !did) return
  const entry = readDraftTable(did).find(e => e.id === draftId)
  setComposeVisibility(
    entry
      ? {visibility: 'private', audience: entry.audience, locked: false}
      : PUBLIC_COMPOSE,
  )
}

/**
 * Whether the draft `draftId` was saved Private (the drafts list's lock, v2
 * round 2 fix 3). Read at render: the table is local and synchronous, and the
 * drafts list renders again after every save.
 */
export function isPrivateDraft(draftId: string): boolean {
  const did = getCurrentDid()
  if (!PRIVATE_POSTING || !did) return false
  return readDraftTable(did).some(entry => entry.id === draftId)
}

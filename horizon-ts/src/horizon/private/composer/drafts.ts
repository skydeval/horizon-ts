/*
 * The draft visibility table. Bluesky's drafts are stored on the public
 * AppView and have no field for visibility, so Horizon remembers, per account
 * and by draft id, whether each draft was saved Public or Private and with
 * which audience, so a draft saved Private comes back Private.
 *
 * The table is local to the device, but the drafts sync to every device
 * (`app.bsky.draft`), so a draft is often listed with no entry here: opened on
 * another device, after the account was removed and added back
 * (`forgetRemovedAccount` deletes the table), after site data was cleared, or
 * on native after a restart (`local-store.ts` is in memory). The table fails
 * closed (Phase 5 review pass 7, P5R7-L1): a draft restores Public only on a
 * recorded Public save. Every other draft restores Private, and with no
 * audience chosen unless a Private entry names one, so Post stays disabled
 * until the user picks Public or an audience. It is never widened to Public
 * or Everyone on its own.
 */

import {logger} from '#/logger'
import {type StandingMode} from '#/horizon/private/api/audiences'
import {
  type ComposeAudience,
  type ComposeVisibility,
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

/**
 * A Private draft's audience as the table stores it, written out so that a
 * kind added to `ComposeAudience` fails typecheck in `toDraftAudience` until
 * it is decided how it is stored, and a kind added here fails typecheck in
 * `AUDIENCE_PARSERS` until it is parsed.
 */
export type DraftAudience =
  | {kind: 'mode'; mode: StandingMode}
  | {kind: 'list'; uri: string}
  | {kind: 'unpicked'}

export type DraftEntry =
  | {id: string; visibility: 'public'}
  | {id: string; visibility: 'private'; audience: DraftAudience}

/**
 * The table as read: each entry parsed, beside the raw value it was read
 * from, so a save writes every other entry back as it was (a newer build's
 * entry survives an older build's save).
 */
type ReadEntry = {entry: DraftEntry; raw: unknown}

const UNPICKED: DraftAudience = {kind: 'unpicked'}

function tableKey(did: string) {
  return `horizon:draft-visibility:${did}`
}

function isStandingMode(value: unknown): value is StandingMode {
  return (
    value === 'everyone' ||
    value === 'followers' ||
    value === 'following' ||
    value === 'nobody'
  )
}

/**
 * One parser per stored kind: the audience, or `undefined` when it is
 * malformed.
 */
const AUDIENCE_PARSERS: {
  [K in DraftAudience['kind']]: (
    value: Record<string, unknown>,
  ) => Extract<DraftAudience, {kind: K}> | undefined
} = {
  mode: value =>
    isStandingMode(value.mode) ? {kind: 'mode', mode: value.mode} : undefined,
  list: value =>
    typeof value.uri === 'string' ? {kind: 'list', uri: value.uri} : undefined,
  unpicked: () => ({kind: 'unpicked'}),
}

function hasParser(kind: unknown): kind is DraftAudience['kind'] {
  return (
    typeof kind === 'string' &&
    Object.prototype.hasOwnProperty.call(AUDIENCE_PARSERS, kind)
  )
}

/**
 * A stored audience; anything missing, of an unknown kind (a newer build's)
 * or malformed reads as unpicked, never as a wider audience.
 */
function parseDraftAudience(value: unknown): DraftAudience {
  if (typeof value !== 'object' || value === null) return UNPICKED
  const audience = value as Record<string, unknown>
  if (!hasParser(audience.kind)) return UNPICKED
  return AUDIENCE_PARSERS[audience.kind](audience) ?? UNPICKED
}

/**
 * A stored entry. Public only when `visibility` is exactly `'public'`; any
 * other object with a string `id` is Private. `undefined` for a value with no
 * string `id`, which no draft can be looked up by.
 */
function parseDraftEntry(value: unknown): DraftEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  if (typeof candidate.id !== 'string') return undefined
  if (candidate.visibility === 'public') {
    return {id: candidate.id, visibility: 'public'}
  }
  return {
    id: candidate.id,
    visibility: 'private',
    audience: parseDraftAudience(candidate.audience),
  }
}

/**
 * The account's table, oldest entry first. An unreadable table reads as
 * empty and is logged, so every draft in it restores Private and unpicked;
 * the next save writes a fresh table.
 */
function readEntries(did: string): ReadEntry[] {
  const raw = readLocal(tableKey(did))
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('not an array')
    const entries: ReadEntry[] = []
    for (const value of parsed as unknown[]) {
      const entry = parseDraftEntry(value)
      if (entry) entries.push({entry, raw: value})
    }
    return entries
  } catch (e) {
    logger.warn('draft visibility table unreadable; starting over', {
      message: e instanceof Error ? e.message : String(e),
    })
    return []
  }
}

/**
 * The account's table, parsed, oldest entry first.
 */
export function readDraftTable(did: string): DraftEntry[] {
  return readEntries(did).map(read => read.entry)
}

function writeDraftTable(did: string, entries: unknown[]) {
  const kept = entries.slice(-MAX_DRAFT_ENTRIES)
  writeLocal(tableKey(did), kept.length ? JSON.stringify(kept) : undefined)
}

/**
 * How a Private compose's audience is stored. A `parent` audience (a reply
 * to a private post) is not reachable here, since Bluesky's drafts carry no
 * reply, and is stored as unpicked so it never restores wider.
 */
function toDraftAudience(audience: ComposeAudience): DraftAudience {
  switch (audience.kind) {
    case 'mode':
      return {kind: 'mode', mode: audience.mode}
    case 'list':
      return {kind: 'list', uri: audience.uri}
    case 'parent':
    case 'unpicked':
      return UNPICKED
    default: {
      const unhandled: never = audience
      return unhandled
    }
  }
}

/**
 * The account and compose visibility a draft save started with, read by
 * `captureDraftVisibility` before the save's first await.
 */
export type CapturedDraftVisibility = {
  did: string
  visibility: ComposeVisibility
}

/**
 * Called when a draft save starts, before its first await: the signed-in
 * account and the compose's visibility at that moment, or `undefined` with
 * no account or Private posting off. The save's network hop can outlast the
 * composer, which resets the compose to Public when it closes, and the
 * account can change meanwhile, so neither is read when the save returns
 * (Phase 5 review pass 8, P5R8-L1).
 */
export function captureDraftVisibility(): CapturedDraftVisibility | undefined {
  const did = getCurrentDid()
  if (!PRIVATE_POSTING || !did) return undefined
  return {did, visibility: getComposeVisibility()}
}

/**
 * Called after every draft save, once the draft id is known: records the
 * visibility captured when the save started for that id, under the account
 * it was captured for, `public`, or `private` with its audience. A Public
 * save is recorded too, never removed, because a draft with no entry
 * restores Private.
 */
export function recordDraftVisibility(
  draftId: string,
  captured: CapturedDraftVisibility | undefined,
) {
  if (!PRIVATE_POSTING || !captured) return
  const {did, visibility: current} = captured
  const others = readEntries(did)
    .filter(read => read.entry.id !== draftId)
    .map(read => read.raw)
  const entry: DraftEntry =
    current.visibility === 'public'
      ? {id: draftId, visibility: 'public'}
      : {
          id: draftId,
          visibility: 'private',
          audience: toDraftAudience(current.audience),
        }
  writeDraftTable(did, [...others, entry])
}

/**
 * The compose a draft restores as: Public for a recorded Public save;
 * Private with its audience for a Private entry (unpicked when none was
 * chosen or it did not parse); Private and unpicked with no entry, or an
 * unreadable table.
 */
export function restoredDraftVisibility(
  entry: DraftEntry | undefined,
): ComposeVisibility {
  if (!entry) {
    return {
      visibility: 'private',
      audience: {kind: 'unpicked', why: 'unsaved'},
      locked: false,
    }
  }
  if (entry.visibility === 'public') return PUBLIC_COMPOSE
  return {
    visibility: 'private',
    audience:
      entry.audience.kind === 'unpicked'
        ? {kind: 'unpicked', why: 'draft'}
        : entry.audience,
    locked: false,
  }
}

/**
 * Called after a draft is restored into the composer: sets the compose as
 * `restoredDraftVisibility` says.
 */
export function applyDraftVisibility(draftId: string) {
  const did = getCurrentDid()
  if (!PRIVATE_POSTING || !did) return
  const entry = readDraftTable(did).find(e => e.id === draftId)
  setComposeVisibility(restoredDraftVisibility(entry))
}

/**
 * Whether the draft `draftId` has a Private entry (the drafts list's lock,
 * v2 round 2 fix 3). A draft with no entry shows no lock, since its hint
 * says it was saved as a private post, but still restores Private. Read at
 * render: the table is local and synchronous, and the drafts list renders
 * again after every save.
 */
export function isPrivateDraft(draftId: string): boolean {
  const did = getCurrentDid()
  if (!PRIVATE_POSTING || !did) return false
  return readDraftTable(did).some(
    entry => entry.id === draftId && entry.visibility === 'private',
  )
}

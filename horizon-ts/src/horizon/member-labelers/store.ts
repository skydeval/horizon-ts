/*
 * The member's labelers, as prism lists them, kept current for the
 * signed-in account.
 *
 * A member labeler exists only for Horizon members. Its id looks like a DID
 * but never resolves, so it is treated as an opaque string: never resolved,
 * never looked up on the AppView, never sent to a PDS and never put in a
 * URL. Its name and policies come from prism's list, its images from prism.
 *
 * For moderation and the "Labeled by" lines each labeler is also given as a
 * labeler view built here (never fetched), with an invalid handle so nothing
 * reads it as an account.
 *
 * The list is kept on the device per account, so a launch can label at once.
 * Images are held in memory only.
 */

import {useSyncExternalStore} from 'react'
import {type Client} from '@atproto/lex'
import {
  type InterpretedLabelValueDefinition,
  interpretLabelValueDefinition,
} from '@bsky/sdk/moderation'

import {logger} from '#/logger'
import {readLocal, writeLocal} from '#/horizon/session/local-store'
import {type app, type com} from '#/lexicons'
import {type RawMemberLabeler} from './api'
import {
  isMemberLabelerId,
  MEMBER_LABELER_ID,
  setKnownMemberLabelerIds,
} from './ids'

type LabelerViewDetailed = app.bsky.labeler.defs.LabelerViewDetailed
type LabelValueDefinition = com.atproto.label.defs.LabelValueDefinition

/** A labeler as Horizon uses it. */
export type MemberLabeler = {
  id: string
  kind: 'moderation' | 'labels_only'
  retired: boolean
  name: string
  description: string | undefined
  /** In-memory image address, once fetched. */
  avatar: string | undefined
  defs: InterpretedLabelValueDefinition[]
  /** The view stock moderation and label UI read, built here. */
  view: LabelerViewDetailed
  /** The report reasons record, as stored by the labeler. */
  reasons: unknown
}

const ID_SHAPE = MEMBER_LABELER_ID

export {isMemberLabelerId}

const STORE_PREFIX = 'horizon:memberLabelers:'

/** The handle given to built views: never a real account. */
export const MEMBER_LABELER_HANDLE = 'handle.invalid'

let account: string | undefined
let labelers: MemberLabeler[] = []
const byId = new Map<string, MemberLabeler>()
/** Image addresses by labeler and image id, kept across refreshes. */
const images = new Map<string, string>()
const listeners = new Set<() => void>()
let version = 0

function notify() {
  version++
  listeners.forEach(listener => listener())
}

/** The current account's labelers. */
export function getMemberLabelers(): readonly MemberLabeler[] {
  return labelers
}

/** A labeler by id. */
export function getMemberLabeler(id: string): MemberLabeler | undefined {
  return byId.get(id)
}

/** The account the list is for. */
export function memberLabelersAccount(): string | undefined {
  return account
}

/** Whether `did` has any labeler to label with. */
export function hasMemberLabelers(did: string | undefined): boolean {
  return !!did && did === account && labelers.length > 0
}

function interpret(raw: RawMemberLabeler, id: string, labelsOnly: boolean) {
  const declared = raw.policies?.policies?.labelValueDefinitions
  if (!Array.isArray(declared)) return []
  const defs: InterpretedLabelValueDefinition[] = []
  for (const each of declared) {
    if (!each || typeof each !== 'object') continue
    const def = each as LabelValueDefinition
    if (typeof def.identifier !== 'string' || def.identifier.startsWith('!')) {
      continue
    }
    try {
      defs.push(
        interpretLabelValueDefinition(
          labelsOnly
            ? {
                ...def,
                // A labels-only labeler never hides or blurs anything.
                blurs: 'none',
                defaultSetting: 'warn',
                adultOnly: false,
              }
            : def,
          id,
        ),
      )
    } catch {
      // A malformed definition is skipped.
    }
  }
  return defs
}

function build(raw: RawMemberLabeler): MemberLabeler | undefined {
  const id = raw.did
  if (!ID_SHAPE.test(id)) return undefined
  const labelsOnly = raw.kind === 'labels_only'
  const name = raw.profile?.displayName?.trim() || 'Labeler'
  const avatarCid = raw.profile?.avatar
  const avatar = avatarCid ? images.get(`${id} ${avatarCid}`) : undefined
  const policies = raw.policies
  const view = {
    $type: 'app.bsky.labeler.defs#labelerViewDetailed',
    uri: `at://${id}/app.bsky.labeler.service/self`,
    cid: 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    creator: {
      did: id,
      handle: MEMBER_LABELER_HANDLE,
      displayName: name,
      ...(raw.profile?.description
        ? {description: raw.profile.description}
        : {}),
      ...(avatar ? {avatar} : {}),
      associated: {labeler: true},
    },
    policies: {
      labelValues: policies?.policies?.labelValues ?? [],
      labelValueDefinitions: (policies?.policies?.labelValueDefinitions ??
        []) as LabelValueDefinition[],
    },
    ...(policies?.reasonTypes ? {reasonTypes: policies.reasonTypes} : {}),
    ...(policies?.subjectTypes ? {subjectTypes: policies.subjectTypes} : {}),
    ...(policies?.subjectCollections
      ? {subjectCollections: policies.subjectCollections}
      : {}),
    indexedAt: new Date(0).toISOString(),
  } as unknown as LabelerViewDetailed
  return {
    id,
    kind: labelsOnly ? 'labels_only' : 'moderation',
    retired: raw.state === 'retired',
    name,
    description: raw.profile?.description,
    avatar,
    defs: interpret(raw, id, labelsOnly),
    view,
    reasons: raw.reasons,
  }
}

function apply(did: string, raws: RawMemberLabeler[]) {
  account = did
  labelers = raws.flatMap(raw => build(raw) ?? [])
  byId.clear()
  for (const labeler of labelers) byId.set(labeler.id, labeler)
  setKnownMemberLabelerIds(byId.keys())
  notify()
}

/**
 * Start from the device's copy for `did` (silent when it matches what is
 * held). Called when the account becomes current.
 */
export function loadMemberLabelers(did: string | undefined) {
  if (did === account) return
  if (!did) {
    account = undefined
    labelers = []
    byId.clear()
    notify()
    return
  }
  let raws: RawMemberLabeler[] = []
  try {
    const stored = readLocal(STORE_PREFIX + did)
    const parsed: unknown = stored ? JSON.parse(stored) : []
    if (Array.isArray(parsed)) raws = parsed as RawMemberLabeler[]
  } catch {
    raws = []
  }
  apply(did, raws)
}

/** Forget `did`'s labelers, here and on the device (no longer a member). */
export function clearMemberLabelers(did: string) {
  writeLocal(STORE_PREFIX + did, undefined)
  if (account === did && labelers.length > 0) apply(did, [])
}

/** prism's calls, passed in so this module loads no network code. */
export type MemberLabelersFetchers = {
  fetchLabelers(pdsClient: Client): Promise<RawMemberLabeler[]>
  fetchImage(
    pdsClient: Client,
    labeler: string,
    cid: string,
  ): Promise<{bytes: ArrayBuffer; type: string}>
}

/**
 * Ask prism for `did`'s labelers and apply the answer; on failure the held
 * list stays. Then fetch any avatar not yet in memory.
 */
export async function refreshMemberLabelers(
  did: string,
  pdsClient: Client,
  fetchers: MemberLabelersFetchers,
) {
  let raws: RawMemberLabeler[]
  try {
    raws = await fetchers.fetchLabelers(pdsClient)
  } catch (error) {
    logger.warn('member labelers: list failed', {
      message: error instanceof Error ? error.message : 'unknown',
    })
    return
  }
  if (account !== undefined && account !== did) return
  try {
    writeLocal(
      STORE_PREFIX + did,
      raws.length ? JSON.stringify(raws) : undefined,
    )
  } catch {
    // A device that cannot store keeps the list in memory.
  }
  apply(did, raws)
  await fetchAvatars(did, pdsClient, raws, fetchers)
}

async function fetchAvatars(
  did: string,
  pdsClient: Client,
  raws: RawMemberLabeler[],
  fetchers: MemberLabelersFetchers,
) {
  let fetched = false
  for (const raw of raws) {
    const cid = raw.profile?.avatar
    if (!cid || typeof cid !== 'string') continue
    const key = `${raw.did} ${cid}`
    if (images.has(key)) continue
    try {
      const {bytes, type} = await fetchers.fetchImage(
        pdsClient,
        raw.did,
        cid,
      )
      images.set(key, toDataUri(bytes, type))
      fetched = true
    } catch {
      // No avatar: the default one is shown.
    }
  }
  if (fetched && account === did) apply(did, raws)
}

function toDataUri(bytes: ArrayBuffer, type: string): string {
  const view = new Uint8Array(bytes)
  let binary = ''
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000))
  }
  const safeType = /^image\/(png|jpeg)$/.test(type) ? type : 'image/jpeg'
  return `data:${safeType};base64,${btoa(binary)}`
}

/** Called whenever the list changes. Returns the unsubscribe function. */
export function subscribeMemberLabelers(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Changes whenever the list changes. */
export function memberLabelersVersion(): number {
  return version
}

/** {@link memberLabelersVersion}, re-rendering on change. */
export function useMemberLabelersVersion(): number {
  return useSyncExternalStore(
    subscribeMemberLabelers,
    memberLabelersVersion,
    memberLabelersVersion,
  )
}

/** The current list, re-rendering on change. */
export function useMemberLabelers(): readonly MemberLabeler[] {
  return useSyncExternalStore(
    subscribeMemberLabelers,
    getMemberLabelers,
    getMemberLabelers,
  )
}

/** Tests: forget everything. */
export function resetMemberLabelers() {
  account = undefined
  labelers = []
  byId.clear()
  images.clear()
  notify()
}

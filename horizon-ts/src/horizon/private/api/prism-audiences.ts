/*
 * Audiences held by prism (prism's private audiences reply; gated on
 * `private.audiences`): the four calls, through the busy-prism wrappers so
 * their outcomes reach health and membership. Each acts on the prism
 * client's own account only.
 */

import {type Client, type LexMap} from '@atproto/lex'
import {type AtUriString} from '@atproto/syntax'

import {nearhorizon} from '#/horizon/lexicons'
import {
  reportedPrismCall,
  reportedPrismWrite,
} from '#/horizon/private/api/reads'
import {servesFeature} from '#/horizon/routing/features'

/**
 * Whether `did`'s audiences live on prism. Read from the held feature list
 * for writes too: the switch only goes one way, and a write sent to the
 * repo after it would be ignored, so the device's copy of the list is
 * trusted rather than waiting for this run's answer.
 */
export function audiencesOnPrism(did: string | undefined): boolean {
  return !!did && servesFeature('private.audiences', did)
}

/** One listed row, as prism answers it. */
export type PrismAudienceRow = {uri: string; cid: string; record: unknown}

/** prism's page size for the list. */
const PAGE = 100
/** A guard against a cursor that never ends (200 audiences fit in 2 pages). */
const MAX_PAGES = 20

/**
 * Every audience the account holds on prism, following the cursor to its
 * end (a page may end early with a cursor, prism's reply 1).
 */
export async function listPrismAudiences(
  prism: Client,
  did: string,
): Promise<PrismAudienceRow[]> {
  const rows: PrismAudienceRow[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = {limit: PAGE, cursor}
    const {body} = await reportedPrismCall(nearhorizon.privateListAudiences, {
      did,
      send: signal =>
        prism.call(nearhorizon.privateListAudiences, params, {signal}),
    })
    rows.push(...body.audiences)
    cursor = body.cursor
    if (!cursor) break
  }
  return rows
}

/** Create an audience on prism. Answers its URI and version token. */
export function createPrismAudience(
  prism: Client,
  did: string,
  record: LexMap,
): Promise<{uri: string; cid: string}> {
  return reportedPrismWrite(nearhorizon.privateCreateAudience, {
    did,
    send: () => prism.call(nearhorizon.privateCreateAudience, {record}),
  })
}

/** Replace an audience on prism, swapped on the token it was listed with. */
export function updatePrismAudience(
  prism: Client,
  did: string,
  {uri, record, swapCid}: {uri: string; record: LexMap; swapCid: string},
): Promise<{uri: string; cid: string}> {
  return reportedPrismWrite(nearhorizon.privateUpdateAudience, {
    did,
    send: () =>
      prism.call(nearhorizon.privateUpdateAudience, {
        uri: uri as AtUriString,
        record,
        swapCid,
      }),
  })
}

/** Delete an audience on prism. Idempotent. */
export async function deletePrismAudience(
  prism: Client,
  did: string,
  uri: string,
): Promise<void> {
  await reportedPrismWrite(nearhorizon.privateDeleteAudience, {
    did,
    send: () =>
      prism.call(nearhorizon.privateDeleteAudience, {uri: uri as AtUriString}),
  })
}

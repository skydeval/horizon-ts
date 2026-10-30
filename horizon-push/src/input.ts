/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  APP_ID,
  MAX_NOTIFY_DIDS,
  PLATFORMS,
  SERVICE_DID,
  SERVICE_ENDPOINT,
  SERVICE_ID,
} from './config'

const DID_RE = /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9.-]+)$/

/** Checks a notify body (`{dids}`); returns an error message or the DIDs. */
export function readNotifyInput(body: unknown): string[] | string {
  const dids = (body as {dids?: unknown} | null)?.dids
  if (!Array.isArray(dids) || dids.length === 0) return 'dids must be a non-empty array'
  if (dids.length > MAX_NOTIFY_DIDS) return `at most ${MAX_NOTIFY_DIDS} dids`
  if (!dids.every(d => typeof d === 'string' && DID_RE.test(d))) return 'dids must be DIDs'
  return [...new Set(dids as string[])]
}

/** The service's DID document. */
export const DID_DOC = {
  '@context': ['https://www.w3.org/ns/did/v1'],
  id: SERVICE_DID,
  service: [
    {
      id: SERVICE_ID,
      type: 'HorizonPushService',
      serviceEndpoint: SERVICE_ENDPOINT,
    },
  ],
}

export type PushInput = {serviceDid: string; token: string; platform: string; appId: string}

/** Checks a register or unregister body; returns an error message or the input. */
export function readPushInput(body: unknown): PushInput | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'expected a JSON object'
  const b = body as Partial<Record<keyof PushInput, unknown>>
  if (b.serviceDid !== SERVICE_DID) return `serviceDid must be ${SERVICE_DID}`
  if (b.appId !== APP_ID) return `appId must be ${APP_ID}`
  if (typeof b.platform !== 'string' || !(PLATFORMS as readonly string[]).includes(b.platform)) {
    return `platform must be one of: ${PLATFORMS.join(', ')}`
  }
  if (typeof b.token !== 'string' || b.token.length < 8 || b.token.length > 4096) {
    return 'token is missing or malformed'
  }
  return {serviceDid: b.serviceDid, token: b.token, platform: b.platform, appId: b.appId}
}

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The account a "check" message names, from the background task's payload
 * (`{data: {...}}`, the fields sometimes packed in `data.dataString`).
 */
export function checkedDid(data: unknown): string | undefined {
  const d = (data as {data?: Record<string, unknown>} | undefined)?.data
  if (!d || typeof d !== 'object') return undefined
  let fields: Record<string, unknown> = d
  if (typeof d.dataString === 'string') {
    try {
      fields = JSON.parse(d.dataString) as Record<string, unknown>
    } catch {
      return undefined
    }
  }
  if (fields.kind !== 'check') return undefined
  return typeof fields.did === 'string' && fields.did.startsWith('did:')
    ? fields.did
    : undefined
}

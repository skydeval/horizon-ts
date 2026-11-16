/*
 * Reports to member labelers, sent straight to the operator's cairn
 * (`/direct/xrpc/...` on its own address), never through the member's PDS
 * and never through prism.
 *
 * - The token is the member's own service token, from their PDS, with `aud`
 *   cairn's bare service DID and `lxm` the method. The method names say
 *   nothing about which labeler, and the labeler's id is in the body only.
 * - No cookies and no credentials mode.
 * - "labeler not available" (`400 InvalidRequest`) is final: the member isn't
 *   in the labeler's audience, or it's retired or gone. Only
 *   `503 MembershipUnavailable` is worth trying again.
 */

import {type Client} from '@atproto/lex'
import {type NsidString} from '@atproto/syntax'

import {getServiceAuthToken} from '#/lib/media/video/upload.shared'
import {networkAwareFetch} from '#/state/session/network'
import {cairnUrl} from '#/horizon/cairn/primary-labeler'

export const REPORT_METHODS = {
  create: 'tools.cairn.report.createDirectReport',
  list: 'tools.cairn.report.getMyDirectReports',
} as const satisfies Record<string, NsidString>

/** A report subject: an account, or a record by URI and CID. */
export type DirectReportSubject =
  | {$type: 'com.atproto.admin.defs#repoRef'; did: string}
  | {$type: 'com.atproto.repo.strongRef'; uri: string; cid: string}

export type DirectReportInput = {
  labeler: string
  subject: DirectReportSubject
  reasonType: string
  reason?: string
}

/** A report as the member's list shows it. */
export type DirectReportView = {
  id: number | string
  labeler: string
  reasonType: string
  subject: unknown
  /** `open` or `closed`. */
  state: string
  createdAt: string
  updatedAt?: string
}

/** Why a report couldn't be sent. Carries no part of the report. */
export class DirectReportError extends Error {
  constructor(
    readonly status: number,
    readonly error: string | undefined,
  ) {
    super(`Report failed: ${status}${error ? ` ${error}` : ''}`)
    this.name = 'DirectReportError'
  }

  /** The labeler won't take this member's reports: don't retry. */
  get notAvailable(): boolean {
    return this.status === 400 && this.error === 'InvalidRequest'
  }

  /** cairn couldn't check membership just now: worth trying again. */
  get retryable(): boolean {
    return this.status === 503 || this.error === 'MembershipUnavailable'
  }
}

/** cairn's service DID, from its address (`did:web:<host>`). */
export function cairnServiceDid(
  base: string | undefined = cairnUrl(),
): string | undefined {
  if (!base) return undefined
  try {
    return `did:web:${new URL(base).host}`
  } catch {
    return undefined
  }
}

type Fetch = typeof fetch

async function call<T>(
  pdsClient: Client,
  lxm: NsidString,
  body: unknown,
  fetchImpl: Fetch,
): Promise<T> {
  const base = cairnUrl()
  const aud = cairnServiceDid(base)
  if (!base || !aud) throw new DirectReportError(0, 'NotConfigured')
  const token = await getServiceAuthToken({client: pdsClient, aud, lxm})
  const response = await fetchImpl(`${base}/direct/xrpc/${lxm}`, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    let error: string | undefined
    try {
      const answer: unknown = await response.json()
      if (answer && typeof answer === 'object' && 'error' in answer) {
        error = typeof answer.error === 'string' ? answer.error : undefined
      }
    } catch {
      // No JSON body.
    }
    throw new DirectReportError(response.status, error)
  }
  return (await response.json()) as T
}

/** Send a report to a member labeler. */
export function createDirectReport(
  pdsClient: Client,
  input: DirectReportInput,
  {fetchImpl = networkAwareFetch}: {fetchImpl?: Fetch} = {},
) {
  return call<{id: number | string}>(
    pdsClient,
    REPORT_METHODS.create,
    input,
    fetchImpl,
  )
}

/** The member's own reports to member labelers, newest first. */
export function getMyDirectReports(
  pdsClient: Client,
  params: {cursor?: string; limit?: number} = {},
  {fetchImpl = networkAwareFetch}: {fetchImpl?: Fetch} = {},
) {
  return call<{reports: DirectReportView[]; cursor?: string}>(
    pdsClient,
    REPORT_METHODS.list,
    params,
    fetchImpl,
  )
}

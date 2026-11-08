/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/*
 * Feedback from Horizon's users: what a report holds, its checks, and what
 * the routes need from a store. A report is sent signed in (service auth
 * through the account's PDS), so the sender is known; only accounts on the
 * FEEDBACK_ADMINS list can read reports.
 */

export const FEEDBACK_SUBMIT = 'app.nearhorizon.feedback.submit'
export const FEEDBACK_LIST = 'app.nearhorizon.feedback.list'
export const FEEDBACK_UPDATE = 'app.nearhorizon.feedback.update'

export const FEEDBACK_KINDS = ['bug', 'idea', 'other'] as const
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]

/** The longest message, in characters. */
export const FEEDBACK_TEXT_MAX = 5000
/** The most technical details, as JSON, in bytes. */
export const FEEDBACK_DETAILS_MAX_BYTES = 4096
/** The most reports one account may send in a day. */
export const FEEDBACK_PER_DAY = 10
/** The most reports one list answer holds. */
export const FEEDBACK_LIST_MAX = 100

export type FeedbackInput = {
  kind: FeedbackKind
  text: string
  /** Technical details the sender chose to include, all strings. */
  details?: Record<string, string>
}

export type FeedbackItem = FeedbackInput & {
  id: number
  did: string
  createdAt: string
  done: boolean
}

/** What the routes need from a store. */
export type FeedbackApi = {
  submit(did: string, input: FeedbackInput): Promise<{id: number} | 'rate-limited'>
  list(options: {
    limit: number
    cursor?: number
    done?: boolean
  }): Promise<{items: FeedbackItem[]; cursor?: number}>
  setDone(id: number, done: boolean): Promise<boolean>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Checks a submitted report; returns an error message or the input. */
export function readFeedbackInput(body: unknown): FeedbackInput | string {
  if (!isObject(body)) return 'expected a JSON object'
  const {kind, text, details} = body
  if (typeof kind !== 'string' || !(FEEDBACK_KINDS as readonly string[]).includes(kind)) {
    return `kind must be one of ${FEEDBACK_KINDS.join(', ')}`
  }
  if (typeof text !== 'string' || text.trim().length === 0) return 'text is required'
  // The app counts graphemes up to FEEDBACK_TEXT_MAX; code points get headroom
  if ([...text].length > FEEDBACK_TEXT_MAX * 2) {
    return `text is over ${FEEDBACK_TEXT_MAX} characters`
  }
  let kept: Record<string, string> | undefined
  if (details !== undefined) {
    if (!isObject(details)) return 'details must be an object'
    kept = {}
    for (const [key, value] of Object.entries(details)) {
      if (typeof value !== 'string') return 'details must hold strings only'
      kept[key] = value
    }
    if (new TextEncoder().encode(JSON.stringify(kept)).length > FEEDBACK_DETAILS_MAX_BYTES) {
      return `details are over ${FEEDBACK_DETAILS_MAX_BYTES} bytes`
    }
  }
  return {kind: kind as FeedbackKind, text: text.trim(), ...(kept ? {details: kept} : {})}
}

/** The accounts that may read reports, from the FEEDBACK_ADMINS setting. */
export function feedbackAdmins(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map(did => did.trim())
      .filter(did => did.startsWith('did:')),
  )
}

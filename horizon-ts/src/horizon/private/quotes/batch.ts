/*
 * Quote reads in batches (prism busy design 4, "Holds"; 4.1, Recovery; 6.3):
 *
 * - `readQuotes(did, uris)`: one read (25 to a call) of every quote asked,
 *   ignoring freshness, each written through `quoteFromRead`.
 * - The gather: a quote slot that mounts while the account is not confirmed
 *   reads through a window of {@link QUOTE_GATHER_MS}, so slots that mount
 *   late together make one `getPosts` (BR14-L2).
 * - The quote timer: one per account, at the earliest held quote's
 *   `suspectRetryAt`, reads every held quote due within 1 s (BR10-N5).
 * - The lift: when the account turns confirmed, every mounted gated slot not
 *   answered since its floor is read in one batch, outside the catch-up's
 *   rate limit.
 *
 * `readQuotes` lives here rather than in `known.ts` (design 4's list): it
 * reads prism, and the registry is read by the read wrapper itself.
 */

import {type QueryClient} from '@tanstack/react-query'

import {logger} from '#/logger'
import {PrivateWaiterError} from '#/horizon/private/api/transient'
import {
  answeredSince,
  heldQueries,
  isOwnPrivateUri,
  subscribeRegistry,
  suspectRefetchInterval,
} from '#/horizon/private/known'
import {readPrivatePostViewsAnswered} from '#/horizon/private/links'
import {mountedGatedSlots} from '#/horizon/private/load-gate'
import {
  privateQuoteQueryKey,
  type QuoteData,
  quoteFromRead,
  type QuoteRead,
} from '#/horizon/private/quotes/verdicts'
import {
  getCurrentClients,
  getCurrentDid,
} from '#/horizon/routing/current-clients'
import {
  healthEnvironment,
  isPrismConfirmed,
  subscribePrismHealth,
} from '#/horizon/routing/health'

/** How long late quote slots gather before their one read (4.1). */
export const QUOTE_GATHER_MS = 1_000

/** A held quote is due when it may be read within this long (4). */
const DUE_WITHIN_MS = 1_000

function clientsFor(did: string) {
  const clients = getCurrentClients()
  if (!clients || clients.did !== did || !clients.queryClient) return undefined
  return clients as typeof clients & {queryClient: QueryClient}
}

/** One read of `uris` for `did`, or `undefined` with no clients. */
async function readFor(
  did: string,
  uris: readonly string[],
): Promise<QuoteRead | undefined> {
  const clients = clientsFor(did)
  if (!clients) return undefined
  return readPrivatePostViewsAnswered(clients, uris)
}

/**
 * Read every quote of `uris` in one batch, ignoring freshness, and write each
 * through `quoteFromRead` (6.3). A failed read writes nothing: the values
 * stay, at their age, and their holds remain.
 */
export async function readQuotes(
  did: string,
  uris: readonly string[],
): Promise<void> {
  const unique = Array.from(new Set(uris))
  if (unique.length === 0) return
  const clients = clientsFor(did)
  if (!clients) return
  let read: QuoteRead | undefined
  try {
    read = await readFor(did, unique)
  } catch (error) {
    logger.info('quote batch read failed', {safeMessage: error})
    return
  }
  if (!read) return
  const qc = clients.queryClient
  for (const uri of unique) {
    const key = privateQuoteQueryKey(uri)
    const previous = qc.getQueryData<QuoteData>(key)
    const value = quoteFromRead(uri, read, previous, qc)
    if (value !== previous) qc.setQueryData(key, value)
  }
}

type Waiting = {
  resolve: (value: QuoteData) => void
  reject: (error: unknown) => void
  previous: () => QuoteData | undefined
}

/** Per account: the quotes waiting for the gather's read. */
const gathers = new Map<string, Map<string, Waiting[]>>()

/**
 * The quote at `uri` read through the gather (4.1): every quote asked within
 * {@link QUOTE_GATHER_MS} of the first is read in one batch. Each caller gets
 * its own value, or its own error (BR12-N7).
 */
export function gatherQuoteRead(
  did: string,
  uri: string,
  previous: () => QuoteData | undefined,
): Promise<QuoteData> {
  return new Promise<QuoteData>((resolve, reject) => {
    let gather = gathers.get(did)
    if (!gather) {
      gather = new Map()
      gathers.set(did, gather)
      healthEnvironment().setTimeout(() => {
        void flushGather(did)
      }, QUOTE_GATHER_MS)
    }
    const waiting = gather.get(uri) ?? []
    waiting.push({resolve, reject, previous})
    gather.set(uri, waiting)
  })
}

async function flushGather(did: string) {
  const gather = gathers.get(did)
  gathers.delete(did)
  if (!gather || gather.size === 0) return
  const uris = Array.from(gather.keys())
  let read: QuoteRead | undefined
  try {
    read = await readFor(did, uris)
  } catch (error) {
    gather.forEach(waiting =>
      waiting.forEach(w => w.reject(new PrivateWaiterError(error))),
    )
    return
  }
  const qc = clientsFor(did)?.queryClient
  gather.forEach((waiting, uri) => {
    waiting.forEach(w => {
      if (!read) {
        w.reject(new PrivateWaiterError(new Error('No account to read for')))
        return
      }
      w.resolve(quoteFromRead(uri, read, w.previous(), qc))
    })
  })
}

/** The held quotes of `did` and when each may be read again. */
function heldQuotes(did: string): {uri: string; inMs: number}[] {
  const out: {uri: string; inMs: number}[] = []
  for (const held of heldQueries(did)) {
    if (held.queryKey[0] !== 'horizon-private-quote' || !held.uri) continue
    const inMs = suspectRefetchInterval(did, held.uri)
    if (inMs !== false) out.push({uri: held.uri, inMs})
  }
  return out
}

let timer: {handle: unknown; at: number; did: string} | undefined

/** (Re)arm the quote timer at the earliest held quote's retry (4). */
function scheduleQuoteTimer() {
  const did = getCurrentDid()
  const env = healthEnvironment()
  if (!did) return
  const held = heldQuotes(did)
  if (held.length === 0) {
    if (timer) env.clearTimeout(timer.handle)
    timer = undefined
    return
  }
  const inMs = Math.min(...held.map(item => item.inMs))
  const at = env.now() + inMs
  if (timer && timer.did === did && timer.at <= at) return
  if (timer) env.clearTimeout(timer.handle)
  timer = {
    did,
    at,
    handle: env.setTimeout(() => {
      timer = undefined
      const due = heldQuotes(did)
        .filter(item => item.inMs <= DUE_WITHIN_MS)
        .map(item => item.uri)
      void readQuotes(did, due).finally(scheduleQuoteTimer)
    }, inMs),
  }
}

let watching = false

/**
 * Start the quote timer and the slots' lift, once (called by the quote
 * reads; importing this module has no side effect).
 */
export function watchQuotes() {
  if (watching) return
  watching = true
  subscribeRegistry(scheduleQuoteTimer)
  const first = getCurrentDid()
  let confirmed = new Map<string, boolean>(
    first ? [[first, isPrismConfirmed(first)]] : [],
  )
  subscribePrismHealth(() => {
    const did = getCurrentDid()
    if (!did) return
    const now = isPrismConfirmed(did)
    const before = confirmed.get(did) ?? now
    confirmed = new Map([[did, now]])
    if (before || !now) return
    // The lift (4.1): mounted slots not answered since their floor, in one read.
    const uris = mountedGatedSlots()
      .filter(
        slot =>
          !isOwnPrivateUri(slot.uri, did) &&
          !answeredSince(did, slot.uri, slot.floor),
      )
      .map(slot => slot.uri)
    void readQuotes(did, uris)
  })
  scheduleQuoteTimer()
}

/** Forget the gather, the timer and the watch (tests). */
export function resetQuoteBatch() {
  gathers.clear()
  if (timer) healthEnvironment().clearTimeout(timer.handle)
  timer = undefined
}

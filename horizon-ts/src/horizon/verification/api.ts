/*
 * prism's public badge reads, called straight at prism with no auth:
 * `getBadges` (the catalogue) and `getSubjectBadges` (which badges accounts
 * hold). Horizon reads public profiles from the public AppView, which knows
 * nothing of these, so badges come from prism by DID.
 *
 * The DIDs rendered in one tick are batched into a single call of at most
 * 100. An account's answer is kept for a minute, as prism caches it.
 */

import {networkAwareFetch} from '#/state/session/network'
import {PRISM_URL} from '#/horizon/routing/prism'
import {
  type Badge,
  type HeldBadge,
  parseBadgeCatalog,
  parseSubjectBadges,
} from './badges'

export const GET_BADGES = 'app.nearhorizon.verification.getBadges'
export const GET_SUBJECT_BADGES =
  'app.nearhorizon.verification.getSubjectBadges'

const MAX_DIDS = 100
const HELD_TTL_MS = 60_000
/** After a failed read, wait this long before asking prism again. */
const FAILED_BACKOFF_MS = 5 * 60_000

type Fetch = typeof fetch

/** The badge catalogue, in prism's order. */
export async function fetchBadgeCatalog(
  fetchImpl: Fetch = networkAwareFetch,
): Promise<Badge[]> {
  const response = await fetchImpl(new URL(`/xrpc/${GET_BADGES}`, PRISM_URL))
  if (!response.ok) throw new Error(`getBadges failed: ${response.status}`)
  return parseBadgeCatalog(await response.json(), PRISM_URL)
}

/** The badges each of `dids` holds; an account with none is absent. */
export async function fetchSubjectBadges(
  dids: readonly string[],
  fetchImpl: Fetch = networkAwareFetch,
): Promise<Map<string, HeldBadge[]>> {
  const url = new URL(`/xrpc/${GET_SUBJECT_BADGES}`, PRISM_URL)
  for (const did of dids) url.searchParams.append('dids', did)
  const response = await fetchImpl(url)
  if (!response.ok) {
    throw new Error(`getSubjectBadges failed: ${response.status}`)
  }
  return parseSubjectBadges(await response.json())
}

type Waiter = {
  resolve: (held: HeldBadge[]) => void
}

/** Batches lookups by DID; one instance per app (`heldBadgesLoader`). */
export class HeldBadgesLoader {
  private kept = new Map<string, {held: HeldBadge[]; at: number}>()
  private pending = new Map<string, Waiter[]>()
  private scheduled = false
  private failedAt = -Infinity

  constructor(
    private fetchImpl: Fetch = networkAwareFetch,
    private now: () => number = Date.now,
  ) {}

  /** A held list kept from a recent answer, if any. */
  peek(did: string): HeldBadge[] | undefined {
    const kept = this.kept.get(did)
    if (kept && this.now() - kept.at < HELD_TTL_MS) return kept.held
    return undefined
  }

  /** The badges `did` holds; never rejects (nothing on failure). */
  load(did: string): Promise<HeldBadge[]> {
    const kept = this.peek(did)
    if (kept) return Promise.resolve(kept)
    if (this.now() - this.failedAt < FAILED_BACKOFF_MS) {
      return Promise.resolve([])
    }
    return new Promise(resolve => {
      const waiters = this.pending.get(did)
      if (waiters) waiters.push({resolve})
      else this.pending.set(did, [{resolve}])
      this.schedule()
    })
  }

  private schedule() {
    if (this.scheduled) return
    this.scheduled = true
    setTimeout(() => {
      this.scheduled = false
      void this.flush()
    }, 0)
  }

  private async flush() {
    const batch = new Map(this.pending)
    this.pending.clear()
    const dids = [...batch.keys()]
    for (let i = 0; i < dids.length; i += MAX_DIDS) {
      const chunk = dids.slice(i, i + MAX_DIDS)
      let answer: Map<string, HeldBadge[]> | undefined
      try {
        answer = await fetchSubjectBadges(chunk, this.fetchImpl)
      } catch {
        this.failedAt = this.now()
      }
      const at = this.now()
      for (const did of chunk) {
        const held = answer?.get(did) ?? []
        if (answer) this.kept.set(did, {held, at})
        for (const waiter of batch.get(did) ?? []) waiter.resolve(held)
      }
    }
  }

  /** Forget everything (tests, account switch). */
  reset() {
    this.kept.clear()
    this.failedAt = -Infinity
  }
}

export const heldBadgesLoader = new HeldBadgesLoader()

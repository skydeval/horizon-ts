/*
 * Fakes for the "Save my appearance" tests (appearance storage choice
 * design, section 10): a PDS with the reference PDS's swap semantics, a
 * prism with `getAppearance` and `putAppearance` swapped on `rev`, and the
 * real membership probe answered from a fake. A test file must mock the
 * session, the toast, the logger, the device store, the notices and
 * `#/horizon/session/local-store` itself (mocks are per file), and opt out
 * of the suite's `multiformats` mocks so CIDs validate.
 */

import {type Call, fakeClient, type Reply} from '#/horizon/private/__tests__/fixtures'
import {
  type ProbeEnvironment,
  startMembershipProbe,
} from '#/horizon/routing/membership'

const COLLECTION = 'app.nearhorizon.actor.appearance'

/** Valid dag-cbor CIDs, one per write. */
export const CIDS = [
  'bafyreidmgwwbgfs5hyk45qvcodrlfdrhqvy6ngrnqkzy6o4wbx2bvieoue',
  'bafyreih4tvvvw3ejmgce7opjt4lltcd5as77rfp72p7oitronwmw6uodfq',
  'bafyreicgyyo55dvc4kzweqmpryylmqcgvexzwb6z4mafwa7o7aepx564j4',
  'bafyreieueeufmkiphnxwkt654txnwd6b7ukhfn3nzoq6t4ypjuitgwj4pe',
  'bafyreib4bnmv63jl43bfylaymmmkuhuezotehaiis6fk7yn3saw7dkcyam',
  'bafyreid6xzjropa2tpjyp6bj5z45zwjubnw2yr7akfatn33itonjyfbx2m',
]

export type Stored = {value: Record<string, unknown>; cid: string} | null

/** A held reply: the request waits until the test releases it. */
export type Gate = {release: () => void; promise: Promise<void>}

export function gate(): Gate {
  let release = () => {}
  const promise = new Promise<void>(resolve => {
    release = resolve
  })
  return {release, promise}
}

/** A record value as Horizon writes it. */
export function recordValue(overrides: Record<string, unknown> = {}) {
  return {
    $type: COLLECTION,
    version: 1,
    backdrop: 'pride.bi',
    custom: {mode: 'twoTone', a: '#FFE2FF', b: '#CCFFFF'},
    updatedAt: '2026-10-20T12:00:00.000Z',
    ...overrides,
  }
}

/**
 * A fake PDS with the reference PDS's swap semantics: `swapRecord: null`
 * means no record may exist, a CID must match, an absent field never swaps.
 * `next` overrides the next replies per method, in order; `holds` makes the
 * next request of a method wait for its gate (applied when released).
 */
export function fakePds(did: string, initial: Stored = null) {
  const server = {
    stored: initial,
    calls: [] as Call[],
    next: {get: [] as Reply[], put: [] as Reply[], delete: [] as Reply[]},
    holds: {get: [] as Gate[], put: [] as Gate[], delete: [] as Gate[]},
    writes: 0,
  }
  const {client} = fakeClient(did, async call => {
    server.calls.push(call)
    if (call.nsid === 'com.atproto.repo.getRecord') {
      const hold = server.holds.get.shift()
      const stored = server.stored
      if (hold) await hold.promise
      const forced = server.next.get.shift()
      if (forced) return forced
      if (!stored) {
        return {status: 400, body: {error: 'RecordNotFound', message: 'none'}}
      }
      return {
        status: 200,
        body: {
          uri: `at://${did}/${COLLECTION}/self`,
          cid: stored.cid,
          value: stored.value,
        },
      }
    }
    if (call.nsid === 'com.atproto.repo.putRecord') {
      const hold = server.holds.put.shift()
      if (hold) await hold.promise
      const forced = server.next.put.shift()
      if (forced) return forced
      const body = call.body ?? {}
      const current = server.stored?.cid ?? null
      if ('swapRecord' in body && body.swapRecord !== current) {
        return {status: 400, body: {error: 'InvalidSwap', message: 'swap'}}
      }
      const cid = CIDS[server.writes++ % CIDS.length]
      server.stored = {value: body.record as Record<string, unknown>, cid}
      return {status: 200, body: {uri: `at://${did}/${COLLECTION}/self`, cid}}
    }
    if (call.nsid === 'com.atproto.repo.deleteRecord') {
      const hold = server.holds.delete.shift()
      if (hold) await hold.promise
      const forced = server.next.delete.shift()
      if (forced) return forced
      const body = call.body ?? {}
      if (
        'swapRecord' in body &&
        body.swapRecord !== (server.stored?.cid ?? null)
      ) {
        return {status: 400, body: {error: 'InvalidSwap', message: 'swap'}}
      }
      server.stored = null
      return {status: 200, body: {}}
    }
    return {status: 404, body: {error: 'MethodNotImplemented'}}
  })
  return {server, client}
}

export type PrismRow = {
  store: 'private' | 'public' | 'device'
  appearance?: Record<string, unknown>
  rev: string
}

/** prism's retention after a removal (prism's reply). */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

const NOT_ENROLLED: Reply = {
  status: 400,
  body: {error: 'NotEnrolled', message: 'Not enrolled in this AppView'},
}

/**
 * A fake prism: `getAppearance` answers the row (`{}` with none);
 * `putAppearance` checks the store, the value's 16 KiB cap (prism's reply;
 * other fields are kept as sent), swaps on
 * `swapRev` (`''`: only if there is no row) and gives every write a new
 * `rev`.
 *
 * The retention (prism's reply, `b14247b`): `removeFromPrism` makes the
 * account a non-member and keeps its row until `retainedUntil` (the removal
 * plus 7 days, by `server.now`). A retained row is answered only with
 * `includeRetained`, marked `retainedUntil`; without it a member gets `{}`
 * and a non-member `NotEnrolled`. Any put replaces it (`swapRev` `''` or its
 * `rev`). `releaseAppearance` deletes it on its `rev`, answers `{}` with
 * none, and `InvalidRequest` to a member. Past `retainedUntil` it is gone.
 */
export function fakePrism(did: string, initial: PrismRow | null = null) {
  const server = {
    row: initial,
    /** Whether the account is a member. */
    member: true,
    /** Epoch ms the row is kept until, while retained. */
    retainedUntil: null as number | null,
    now: () => Date.now(),
    calls: [] as Call[],
    next: {get: [] as Reply[], put: [] as Reply[], release: [] as Reply[]},
    holds: {get: [] as Gate[], put: [] as Gate[]},
    revs: 0,
  }
  const sweep = () => {
    if (server.retainedUntil !== null && server.now() >= server.retainedUntil) {
      server.row = null
      server.retainedUntil = null
    }
  }
  const body = () =>
    server.row
      ? {
          store: server.row.store,
          rev: server.row.rev,
          ...(server.row.appearance ? {appearance: server.row.appearance} : {}),
        }
      : {}
  const {client} = fakeClient(did, async call => {
    server.calls.push(call)
    if (call.nsid === 'app.nearhorizon.private.getAppearance') {
      const hold = server.holds.get.shift()
      // A held read is served when released: it answers what is there then.
      if (hold) await hold.promise
      const forced = server.next.get.shift()
      if (forced) return forced
      sweep()
      if (server.retainedUntil !== null) {
        if (call.params.get('includeRetained') === 'true') {
          const retainedUntil = new Date(server.retainedUntil).toISOString()
          return {status: 200, body: {...body(), retainedUntil}}
        }
        return server.member ? {status: 200, body: {}} : NOT_ENROLLED
      }
      return server.member ? {status: 200, body: body()} : NOT_ENROLLED
    }
    if (call.nsid === 'app.nearhorizon.private.releaseAppearance') {
      const forced = server.next.release.shift()
      if (forced) return forced
      sweep()
      if (server.member) {
        return {status: 400, body: {error: 'InvalidRequest', message: 'member'}}
      }
      if (server.retainedUntil === null) return {status: 200, body: {}}
      if (call.body?.rev !== server.row?.rev) {
        return {status: 400, body: {error: 'InvalidSwap', message: 'rev'}}
      }
      server.row = null
      server.retainedUntil = null
      return {status: 200, body: {}}
    }
    if (call.nsid === 'app.nearhorizon.private.putAppearance') {
      const hold = server.holds.put.shift()
      if (hold) await hold.promise
      const forced = server.next.put.shift()
      if (forced) return forced
      sweep()
      if (!server.member) return NOT_ENROLLED
      const input = call.body ?? {}
      const store = input.store as PrismRow['store']
      const hasValue = input.appearance !== undefined
      if (store === 'device' ? hasValue : !hasValue) {
        return {status: 400, body: {error: 'InvalidRequest', message: 'shape'}}
      }
      // prism's cap: 16 KiB of compact JSON.
      if (
        hasValue &&
        Buffer.byteLength(JSON.stringify(input.appearance)) > 16384
      ) {
        return {
          status: 400,
          body: {
            error: 'InvalidRequest',
            message: 'Error: appearance is too large (16384 bytes at most)',
          },
        }
      }
      if ('swapRev' in input) {
        const current = server.row?.rev ?? ''
        // A create-only put also replaces a retained row.
        const retained = server.retainedUntil !== null && input.swapRev === ''
        if (input.swapRev !== current && !retained) {
          return {status: 400, body: {error: 'InvalidSwap', message: 'rev'}}
        }
      }
      server.retainedUntil = null
      server.row = {
        store,
        rev: `rev-${++server.revs}`,
        ...(hasValue
          ? {appearance: input.appearance as Record<string, unknown>}
          : {}),
      }
      return {status: 200, body: body()}
    }
    return {status: 501, body: {error: 'MethodNotImplemented'}}
  })
  return {server, client}
}

type FakePrismServer = ReturnType<typeof fakePrism>['server']

/** The account is removed: its row (if any) is kept for 7 days. */
export function removeFromPrism(server: FakePrismServer) {
  server.member = false
  server.retainedUntil = server.row ? server.now() + RETENTION_MS : null
}

/** The account is a member again; a retained row stays until a put. */
export function rejoinPrism(server: FakePrismServer) {
  server.member = true
}

const quietEnv: ProbeEnvironment = {
  setTimeout: () => undefined,
  clearTimeout: () => {},
  isHidden: () => false,
  onVisible: () => () => {},
}

/** Let every pending promise and zero-delay timer run. */
export async function drain(rounds = 30) {
  for (let i = 0; i < rounds; i++) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

/**
 * Answer `did`'s membership as prism's `getMembership` would, through the
 * real probe: `member` with `private.appearance` listed (`feature`), or not,
 * and `private.appearanceRetention` listed (`retention`), or not.
 */
export async function answerMembership(
  did: string,
  status: 'member' | 'notEligible' | 'indexing',
  {feature = true, retention = true}: {feature?: boolean; retention?: boolean} = {},
) {
  const features = [
    'private',
    ...(feature ? ['private.appearance'] : []),
    ...(retention ? ['private.appearanceRetention'] : []),
  ]
  const probe = fakeClient(did, () => ({
    status: 200,
    body: {status, features, validForSecs: 3600},
  }))
  const cancel = startMembershipProbe(did, probe.client, quietEnv)
  await drain(5)
  cancel()
}

export function callsOf(server: {calls: Call[]}, nsid: string) {
  return server.calls.filter(call => call.nsid === `com.atproto.repo.${nsid}`)
}

export function prismCallsOf(server: {calls: Call[]}, method: string) {
  return server.calls.filter(
    call => call.nsid === `app.nearhorizon.private.${method}`,
  )
}

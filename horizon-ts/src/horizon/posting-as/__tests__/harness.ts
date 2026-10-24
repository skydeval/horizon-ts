/*
 * Fakes for the "Posting as" suites: one fake PDS per account (preferences,
 * the plural records, posts and the front), a fake prism, and the current
 * account published as `CurrentClientsPublisher` would. No network call is
 * made. A suite that validates CIDs must `jest.unmock('multiformats/cid')`
 * first.
 */

import {type Client} from '@atproto/lex'
import {QueryClient} from '@tanstack/react-query'

import {
  type Call,
  fakeClient,
  RECORD_CID,
  type Reply,
} from '#/horizon/private/__tests__/fixtures'
import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'

/** The current account: on locus. */
export const MAIN = 'did:plc:mainaaaaaaaaaaaaaaaaaaaa'
/** Another signed-in account on locus. */
export const OTHER = 'did:plc:otherbbbbbbbbbbbbbbbbbbbb'
/** Another signed-in account on a stock PDS. */
export const STOCKY = 'did:plc:stockccccccccccccccccccccc'
/** Someone who is not one of the user's accounts. */
export const STRANGER = 'did:plc:strangerdddddddddddddddd'

/** The locus origin in jest (`jest/jestSetup.js` sets the origins). */
export const LOCUS_URL = 'https://pds.example'
export const STOCK_URL = 'https://pds.stock.example'

export const WREN = '3m4kq2xv7ad2c'
export const SPARROW = '3m4kq3b5nfe2t'
export const ROBIN = '3m4kq4c6pgf2u'

export const SYSTEM = 'app.nearhorizon.plural.system'
export const MEMBER = 'app.nearhorizon.plural.member'
export const FRONT = 'app.nearhorizon.plural.front'

export function listUri(did: string, rkey = '3klistaaaa22') {
  return `at://${did}/app.bsky.graph.list/${rkey}`
}

export function audienceUri(did: string, rkey = '3kaudience22') {
  return `at://${did}/tools.kryphocron.policy.audience/${rkey}`
}

/** An unsigned JWT for `did` that expires `secs` from now. */
export function jwt(did: string, secs: number, scope = 'com.atproto.access') {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  const exp = Math.floor(Date.now() / 1000) + secs
  return `${encode({alg: 'ES256K', typ: 'JWT'})}.${encode({sub: did, exp, scope})}.sig`
}

/** A stored account for the persisted session, signed in. */
export function storedAccount(did: string, pdsUrl: string, handle: string) {
  return {
    did,
    handle,
    service: pdsUrl,
    pdsUrl,
    refreshJwt: jwt(did, 30 * 24 * 3600, 'com.atproto.refresh'),
    accessJwt: jwt(did, 3600),
    active: true,
    isOauthSession: false,
  }
}

/** One account's fake PDS. */
export type FakeAccount = {
  did: string
  client: Client
  calls: Call[]
  prefs: Record<string, unknown>[]
  system: boolean
  members: Map<string, Record<string, unknown>>
  front: Record<string, unknown> | undefined
  /** Answers a call before the store does; `undefined` lets it through. */
  fail?: (call: Call) => Reply | undefined | Promise<Reply | undefined>
  /** Records written with `applyWrites`, by collection/rkey. */
  written: Map<string, Record<string, unknown>>
}

function notFound(): Reply {
  return {status: 400, body: {error: 'RecordNotFound', message: 'not found'}}
}

/** A fake PDS for `did`. */
export function fakeAccount(
  did: string,
  {
    system = false,
    members = [],
    engaging = [],
    replyRules,
  }: {
    system?: boolean
    members?: {rkey: string; name: string}[]
    engaging?: string[]
    replyRules?: Record<string, unknown>[]
  } = {},
): FakeAccount {
  const account: FakeAccount = {
    did,
    client: undefined as unknown as Client,
    calls: [],
    prefs: replyRules
      ? [
          {
            $type: 'app.bsky.actor.defs#postInteractionSettingsPref',
            threadgateAllowRules: replyRules,
            postgateEmbeddingRules: [],
          },
        ]
      : [],
    system,
    members: new Map(
      members.map(m => [
        m.rkey,
        {
          $type: MEMBER,
          displayName: m.name,
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      ]),
    ),
    front: system
      ? {
          $type: FRONT,
          members: engaging.map(id => ({id, status: 'engaging'})),
          setAt: '2026-10-01T00:00:00.000Z',
        }
      : undefined,
    written: new Map(),
  }
  const handler = async (call: Call): Promise<Reply> => {
    const failure = await account.fail?.(call)
    if (failure) return failure
    const collection = (call.params.get('collection') ??
      call.body?.collection) as string | undefined
    const rkey = (call.params.get('rkey') ?? call.body?.rkey) as
      string | undefined
    switch (call.nsid) {
      case 'app.bsky.actor.getPreferences':
        return {status: 200, body: {preferences: account.prefs}}
      case 'app.bsky.actor.putPreferences':
        account.prefs = (call.body?.preferences ?? []) as Record<
          string,
          unknown
        >[]
        return {status: 200, body: {}}
      case 'com.atproto.repo.getRecord': {
        const uri = `at://${did}/${collection}/${rkey}`
        if (collection === SYSTEM && account.system) {
          return {
            status: 200,
            body: {uri, cid: RECORD_CID, value: {$type: SYSTEM}},
          }
        }
        if (collection === FRONT && account.front) {
          return {
            status: 200,
            body: {uri, cid: RECORD_CID, value: account.front},
          }
        }
        if (collection === MEMBER && rkey && account.members.has(rkey)) {
          return {
            status: 200,
            body: {uri, cid: RECORD_CID, value: account.members.get(rkey)},
          }
        }
        return notFound()
      }
      case 'com.atproto.repo.listRecords':
        if (collection !== MEMBER) return {status: 200, body: {records: []}}
        return {
          status: 200,
          body: {
            records: [...account.members.entries()].map(([key, value]) => ({
              uri: `at://${did}/${MEMBER}/${key}`,
              cid: RECORD_CID,
              value,
            })),
          },
        }
      case 'com.atproto.repo.putRecord':
        if (collection === FRONT) {
          account.front = call.body?.record as Record<string, unknown>
          return {
            status: 200,
            body: {uri: `at://${did}/${FRONT}/self`, cid: RECORD_CID},
          }
        }
        return {status: 501, body: {error: 'MethodNotImplemented'}}
      case 'com.atproto.repo.applyWrites': {
        const writes = (call.body?.writes ?? []) as {
          collection: string
          rkey: string
          value: Record<string, unknown>
        }[]
        for (const write of writes) {
          account.written.set(`${write.collection}/${write.rkey}`, write.value)
        }
        return {status: 200, body: {}}
      }
      default:
        return {status: 501, body: {error: 'MethodNotImplemented'}}
    }
  }
  const fake = fakeClient(did, handler)
  account.client = fake.client
  account.calls = fake.calls
  return account
}

/** Publish `account` as the current account, with a query client. */
export function publishCurrent(
  account: FakeAccount,
  pdsUrl: string,
  handle: string,
  prism: Client = account.client,
  queryClient = new QueryClient(),
) {
  clearCurrentClients()
  publishCurrentClients({
    did: account.did,
    handle,
    pdsUrl,
    pdsClient: account.client,
    prismClient: prism,
    appviewClient: account.client,
    chatClient: account.client,
    queryClient,
  })
  return queryClient
}

/** Let every pending read settle. */
export async function settle(rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

/** The calls of `nsid` an account received. */
export function callsOf(account: FakeAccount, nsid: string) {
  return account.calls.filter(call => call.nsid === nsid)
}

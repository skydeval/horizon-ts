/*
 * The refract suites' harness: a signed-in reader with `refract` listed, a
 * fake transport for the seven methods, and a fake AppView for the stock
 * pre-check. Every fixture is synthetic (`refract/fixtures.ts`); nothing
 * here reaches the network. Each suite mocks `#/horizon/switches` (REFRACT
 * on) and `#/horizon/routing/membership` before importing this file.
 */

import {jest} from '@jest/globals'
import {QueryClient} from '@tanstack/react-query'

import {resetRefractApi, setRefractTransport} from '#/horizon/refract/api'
import {resetRefractFill} from '#/horizon/refract/fill'
import {RF_READER_DID} from '#/horizon/refract/fixtures'
import {resetRefractGate} from '#/horizon/refract/gate'
import {type RefractMethod} from '#/horizon/refract/lexicon'
import {clearNotedRestored} from '#/horizon/refract/marker'
import {resetOwnRelations, seedOwnRelations} from '#/horizon/refract/relations'
import {clearRestoredStore} from '#/horizon/refract/store'
import {
  clearCurrentClients,
  publishCurrentClients,
} from '#/horizon/routing/current-clients'
import {
  answerPrismFeatures,
  resetPrismFeatures,
} from '#/horizon/routing/features'
import {resetPrismHealth} from '#/horizon/routing/health'
import {app} from '#/lexicons'

export type SentCall = {method: RefractMethod; params: Record<string, unknown>}

/** Returns the answer's body, or a promise of it. */
export type Responder = (call: SentCall) => unknown

/** A promise the test resolves. */
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return {promise, resolve, reject}
}

export type Harness = {
  queryClient: QueryClient
  calls: SentCall[]
  fills: () => SentCall[]
  respond: (responder: Responder) => void
  stockProfiles: Set<string>
  precheckCalls: string[][]
}

/** Sign the reader in with `refract` listed and a fake transport. */
export function setupRefract({
  proxied = false,
}: {proxied?: boolean} = {}): Harness {
  resetRefractFill()
  resetRefractApi()
  resetRefractGate()
  resetOwnRelations()
  clearNotedRestored()
  clearRestoredStore()
  resetPrismFeatures()
  resetPrismHealth()
  clearCurrentClients()
  const queryClient = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: Infinity}},
  })
  const stockProfiles = new Set<string>()
  const precheckCalls: string[][] = []
  const appviewClient = {
    call: jest.fn((schema: unknown, params: {actors?: string[]}) => {
      if (schema === app.bsky.actor.getProfiles) {
        precheckCalls.push(params.actors ?? [])
        return Promise.resolve({
          profiles: (params.actors ?? [])
            .filter(did => stockProfiles.has(did))
            .map(did => ({did, handle: 'stock.example.test'})),
        })
      }
      return Promise.resolve({})
    }),
  }
  publishCurrentClients({
    did: RF_READER_DID,
    handle: 'reader.example.test',
    pdsUrl: undefined,
    pdsClient: {} as never,
    prismClient: {} as never,
    appviewClient: appviewClient as never,
    queryClient,
  })
  answerPrismFeatures(RF_READER_DID, ['private', 'refract'])
  seedOwnRelations({})
  const calls: SentCall[] = []
  let responder: Responder = () => ({profiles: [], posts: [], pending: []})
  setRefractTransport(async (method, params) => {
    const call = {method, params}
    calls.push(call)
    const body = await responder(call)
    return {body: JSON.parse(JSON.stringify(body)), proxied}
  })
  return {
    queryClient,
    calls,
    fills: () => calls.filter(call => call.method.endsWith('.fill')),
    respond: next => {
      responder = next
    },
    stockProfiles,
    precheckCalls,
  }
}

/** Let promise callbacks and zero-delay timers run (real timers). */
export async function flush(times = 8) {
  for (let i = 0; i < times; i++) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

/** The DIDs and URIs a fill call asked about. */
export function asked(call: SentCall) {
  return {
    dids: (call.params.dids as string[] | undefined) ?? [],
    uris: (call.params.uris as string[] | undefined) ?? [],
  }
}

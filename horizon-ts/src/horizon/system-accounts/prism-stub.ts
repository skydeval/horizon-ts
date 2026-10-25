/*
 * An in-memory stand-in for prism's five system-account methods, for
 * development builds with `SYSTEM_ACCOUNTS_DEV_STUB` on (system accounts
 * design section 20: build against a stub until SP-1 ships). It keeps each
 * registering account's list for the page load, answers `rev`s that only
 * grow, enforces the cap and the self-add refusal, and accepts any proof
 * whose payload names the added account as `iss`. It contacts no server
 * beyond the proof mint at the added account's own PDS.
 */

import {type Client} from '@atproto/lex'

import {mintOneShotPrismToken} from '#/horizon/routing/prism-direct'
import {MAX_SYSTEM_ACCOUNTS} from './list-store'
import {
  CONFIRM_SYSTEM_ACCOUNT_LXM,
  type SystemAccountsApi,
  SystemAccountsError,
} from './prism-types'

const lists = new Map<string, {did: string; addedAt: string}[]>()
let rev = 0

function nextRev() {
  rev += 1
  return String(rev)
}

function didOf(client: Client): string {
  return client.assertDid
}

function issuerOf(token: string): string | undefined {
  try {
    const payload = token.split('.')[1] ?? ''
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const claims = JSON.parse(atob(padded)) as {iss?: unknown}
    return typeof claims.iss === 'string' ? claims.iss.split('#')[0] : undefined
  } catch {
    return undefined
  }
}

export const stubSystemAccountsApi: SystemAccountsApi = {
  getSystemAccounts(pdsClient) {
    const list = lists.get(didOf(pdsClient)) ?? []
    return Promise.resolve({accounts: [...list], rev: String(rev)})
  },
  async addSystemAccount(pdsClient, account, mintProof) {
    const registrar = didOf(pdsClient)
    if (account === registrar) throw new SystemAccountsError('refused')
    const proof = await mintProof()
    if (issuerOf(proof) !== account) throw new SystemAccountsError('proof')
    const list = lists.get(registrar) ?? []
    if (list.some(a => a.did === account)) return {rev: String(rev)}
    if (list.length >= MAX_SYSTEM_ACCOUNTS) {
      throw new SystemAccountsError('full')
    }
    lists.set(registrar, [
      ...list,
      {did: account, addedAt: new Date().toISOString()},
    ])
    return {rev: nextRev()}
  },
  removeSystemAccount(pdsClient, account) {
    const registrar = didOf(pdsClient)
    lists.set(
      registrar,
      (lists.get(registrar) ?? []).filter(a => a.did !== account),
    )
    return Promise.resolve({rev: nextRev()})
  },
  getSystemAccountStatus(pdsClient) {
    const did = didOf(pdsClient)
    return Promise.resolve({
      registered: [...lists.values()].some(list =>
        list.some(a => a.did === did),
      ),
    })
  },
  leaveSystemAccounts(pdsClient) {
    const did = didOf(pdsClient)
    for (const [registrar, list] of lists) {
      lists.set(
        registrar,
        list.filter(a => a.did !== did),
      )
    }
    nextRev()
    return Promise.resolve()
  },
  mintProof(addedPdsClient) {
    return mintOneShotPrismToken(addedPdsClient, CONFIRM_SYSTEM_ACCOUNT_LXM)
  },
}

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, describe, expect, it, vi} from 'vitest'

import {NodeHub} from '../../src/node/hub'
import {handleRequest} from '../../src/routes'

const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const dirs: string[] = []

function hubAt(dir?: string) {
  const at = dir ?? mkdtempSync(join(tmpdir(), 'push-'))
  if (!dir) dirs.push(at)
  return {dir: at, hub: new NodeHub({dbPath: join(at, 'push.db'), fcmServiceAccount: '{}', listen: false})}
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true})
})

describe('the Node hub', () => {
  it('keeps phones in its SQLite file across a restart', async () => {
    const {dir, hub} = hubAt()
    await hub.register(DID, 'token-1', 'android')
    hub.stop()
    const again = hubAt(dir).hub
    // A registered account is back after the restart: notify queues it.
    await again.notify([DID])
    await again.unregister(DID, 'token-1')
    again.stop()
  })

  it('answers status without counts, closed while not listening', async () => {
    const {hub} = hubAt()
    expect(await hub.status()).toMatchObject({connected: false, upSeconds: 0})
    expect(Object.keys(await hub.status())).not.toContain('accounts')
    hub.stop()
  })

  it('serves the routes: the DID document with both entries', async () => {
    const {hub} = hubAt()
    const res = await handleRequest(new Request('https://push.nearhorizon.app/.well-known/did.json'), hub)
    const doc = (await res.json()) as {service: {id: string}[]}
    expect(doc.service.map(s => s.id)).toEqual(['#horizon_push', '#bsky_notif'])
    const unauth = await handleRequest(
      new Request('https://push.nearhorizon.app/xrpc/app.bsky.notification.registerPush', {method: 'POST'}),
      hub,
    )
    expect(unauth.status).toBe(401)
    hub.stop()
  })
})

describe('nudge timing', () => {
  const like = (n: number) => ({
    did: 'did:plc:ffffffffffffffffffffffff',
    kind: 'commit',
    time_us: 1_700_000_000_000_000 + n,
    commit: {
      operation: 'create',
      collection: 'app.bsky.feed.like',
      rkey: `3k${n}`,
      record: {subject: {uri: `at://${DID}/app.bsky.feed.post/3p`}},
    },
  })

  async function run(events: number, notify = false) {
    vi.useFakeTimers({toFake: ['Date']})
    const start = new Date('2026-11-04T12:00:00Z').getTime()
    vi.setSystemTime(start)
    const {hub} = hubAt()
    const sent: {at: number; events: number}[] = []
    const internals = hub as unknown as {
      nudge: (did: string, notices?: unknown[]) => Promise<void>
      tick: () => Promise<void>
      onMessage: (data: string) => void
    }
    internals.nudge = async (_did, notices = []) => {
      sent.push({at: Date.now() - start, events: notices.length})
    }
    await hub.register(DID, 'token-1', 'android')
    for (let i = 0; i < events; i++) internals.onMessage(JSON.stringify(like(i)))
    if (notify) await hub.notify([DID])
    for (let t = 0; t <= 90_000; t += 500) {
      vi.setSystemTime(start + t)
      await internals.tick()
    }
    hub.stop()
    return sent
  }

  it('sends a burst’s events once, after the delay, with no follow-ups', async () => {
    expect(await run(2)).toEqual([{at: 1_000, events: 2}])
  })

  it('sends one check for more events than fit, or for a notify', async () => {
    expect(await run(6)).toEqual([{at: 1_000, events: 0}])
    expect(await run(0, true)).toEqual([{at: 1_000, events: 0}])
  })
})

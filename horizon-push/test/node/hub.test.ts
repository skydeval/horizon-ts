/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, describe, expect, it} from 'vitest'

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

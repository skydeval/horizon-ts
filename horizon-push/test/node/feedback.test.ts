/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, describe, expect, it, vi} from 'vitest'

// The token check has its own tests; here a bearer "did:..." is that account.
vi.mock('../../src/auth', () => {
  class AuthError extends Error {}
  return {
    AuthError,
    verifyServiceAuth: async (header: string | null) => {
      const did = header?.replace(/^Bearer /, '') ?? ''
      if (!did.startsWith('did:')) throw new AuthError('no token')
      return did
    },
  }
})

import {FEEDBACK_PER_DAY, FEEDBACK_TEXT_MAX, readFeedbackInput} from '../../src/feedback'
import {FeedbackStore} from '../../src/node/feedback'
import {type HubApi, handleRequest} from '../../src/routes'

const USER = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const ADMIN = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'
const BASE = 'https://push.nearhorizon.app/xrpc/'
const dirs: string[] = []

const hub: HubApi = {
  register: async () => {},
  unregister: async () => {},
  notify: async () => {},
  status: async () => ({}),
}

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'feedback-'))
  dirs.push(dir)
  return new FeedbackStore(join(dir, 'feedback.db'))
}

function call(
  feedback: FeedbackStore,
  method: string,
  as: string | undefined,
  init: {body?: unknown; query?: string} = {},
) {
  const isGet = method.endsWith('.list')
  return handleRequest(
    new Request(`${BASE}${method}${init.query ?? ''}`, {
      method: isGet ? 'GET' : 'POST',
      headers: {
        ...(as ? {authorization: `Bearer ${as}`} : {}),
        'content-type': 'application/json',
      },
      ...(isGet ? {} : {body: JSON.stringify(init.body ?? {})}),
    }),
    hub,
    {feedback, admins: ADMIN},
  )
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true})
})

describe('readFeedbackInput', () => {
  it('takes a kind, trimmed text and string details', () => {
    expect(
      readFeedbackInput({kind: 'bug', text: '  broken  ', details: {build: '20'}}),
    ).toEqual({kind: 'bug', text: 'broken', details: {build: '20'}})
  })

  it('refuses an unknown kind, empty or long text, and odd details', () => {
    expect(readFeedbackInput({kind: 'rant', text: 'x'})).toMatch(/kind/)
    expect(readFeedbackInput({kind: 'bug', text: '   '})).toMatch(/text/)
    expect(
      readFeedbackInput({kind: 'bug', text: 'x'.repeat(FEEDBACK_TEXT_MAX * 2 + 1)}),
    ).toMatch(/over/)
    expect(readFeedbackInput({kind: 'bug', text: 'x', details: {n: 1}})).toMatch(/strings/)
    expect(readFeedbackInput({kind: 'bug', text: 'x', details: {a: 'y'.repeat(5000)}})).toMatch(
      /bytes/,
    )
  })
})

describe('feedback routes', () => {
  it('a signed-in account sends a report; an admin reads it and marks it done', async () => {
    const feedback = store()
    const sent = await call(feedback, 'app.nearhorizon.feedback.submit', USER, {
      body: {kind: 'idea', text: 'more themes', details: {platform: 'web'}},
    })
    expect(sent.status).toBe(200)
    const {id} = (await sent.json()) as {id: number}

    const listed = await call(feedback, 'app.nearhorizon.feedback.list', ADMIN)
    const {items} = (await listed.json()) as {items: Record<string, unknown>[]}
    expect(items).toEqual([
      expect.objectContaining({
        id,
        did: USER,
        kind: 'idea',
        text: 'more themes',
        details: {platform: 'web'},
        done: false,
      }),
    ])

    const updated = await call(feedback, 'app.nearhorizon.feedback.update', ADMIN, {
      body: {id, done: true},
    })
    expect(updated.status).toBe(200)
    const open = await call(feedback, 'app.nearhorizon.feedback.list', ADMIN, {
      query: '?done=false',
    })
    expect(((await open.json()) as {items: unknown[]}).items).toEqual([])
    feedback.close()
  })

  it('needs a sign-in to send, and only admins read or update', async () => {
    const feedback = store()
    const anonymous = await call(feedback, 'app.nearhorizon.feedback.submit', undefined, {
      body: {kind: 'bug', text: 'x'},
    })
    expect(anonymous.status).toBe(401)
    expect((await call(feedback, 'app.nearhorizon.feedback.list', USER)).status).toBe(403)
    const update = await call(feedback, 'app.nearhorizon.feedback.update', USER, {
      body: {id: 1, done: true},
    })
    expect(update.status).toBe(403)
    feedback.close()
  })

  it('limits each account to a few reports a day', async () => {
    const feedback = store()
    for (let i = 0; i < FEEDBACK_PER_DAY; i++) {
      const ok = await call(feedback, 'app.nearhorizon.feedback.submit', USER, {
        body: {kind: 'bug', text: `report ${i}`},
      })
      expect(ok.status).toBe(200)
    }
    const over = await call(feedback, 'app.nearhorizon.feedback.submit', USER, {
      body: {kind: 'bug', text: 'one more'},
    })
    expect(over.status).toBe(429)
    // Another account is unaffected
    const other = await call(feedback, 'app.nearhorizon.feedback.submit', ADMIN, {
      body: {kind: 'bug', text: 'mine'},
    })
    expect(other.status).toBe(200)
    feedback.close()
  })

  it('pages the list newest first', async () => {
    const feedback = store()
    for (let i = 0; i < 3; i++) {
      await call(feedback, 'app.nearhorizon.feedback.submit', USER, {
        body: {kind: 'other', text: `note ${i}`},
      })
    }
    const first = (await (
      await call(feedback, 'app.nearhorizon.feedback.list', ADMIN, {query: '?limit=2'})
    ).json()) as {items: {text: string}[]; cursor?: string}
    expect(first.items.map(item => item.text)).toEqual(['note 2', 'note 1'])
    const second = (await (
      await call(feedback, 'app.nearhorizon.feedback.list', ADMIN, {
        query: `?limit=2&cursor=${first.cursor}`,
      })
    ).json()) as {items: {text: string}[]; cursor?: string}
    expect(second.items.map(item => item.text)).toEqual(['note 0'])
    expect(second.cursor).toBeUndefined()
    feedback.close()
  })
})

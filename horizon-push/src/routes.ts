/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/*
 * The HTTP surface, shared by the Cloudflare Worker (`index.ts`) and the
 * Node server (`node/main.ts`): the XRPC methods, the DID document, /status.
 */

import {AuthError, verifyServiceAuth} from './auth'
import {notifySources} from './config'
import {
  FEEDBACK_LIST,
  FEEDBACK_LIST_MAX,
  FEEDBACK_SUBMIT,
  FEEDBACK_UPDATE,
  type FeedbackApi,
  feedbackAdmins,
  readFeedbackInput,
} from './feedback'
import {DID_DOC, readNotifyInput, readPushInput} from './input'

/** What the routes need from the hub, wherever it runs. */
export type HubApi = {
  register(did: string, token: string, platform: string): Promise<void>
  unregister(did: string, token: string): Promise<void>
  notify(dids: string[]): Promise<void>
  status(): Promise<unknown>
}

const REGISTER = 'app.bsky.notification.registerPush'
const UNREGISTER = 'app.bsky.notification.unregisterPush'
const NOTIFY = 'app.nearhorizon.push.notify'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json; charset=utf-8'},
  })
}

function xrpcError(status: number, error: string, message: string): Response {
  return json({error, message}, status)
}

async function pushMethod(request: Request, hub: HubApi, lxm: string): Promise<Response> {
  if (request.method !== 'POST') return xrpcError(405, 'InvalidRequest', 'use POST')
  let did: string
  try {
    did = await verifyServiceAuth(request.headers.get('authorization'), lxm)
  } catch (e) {
    const message = e instanceof AuthError ? e.message : 'could not check the token'
    return xrpcError(401, 'AuthenticationRequired', message)
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return xrpcError(400, 'InvalidRequest', 'expected a JSON body')
  }
  const input = readPushInput(body)
  if (typeof input === 'string') return xrpcError(400, 'InvalidRequest', input)
  if (lxm === REGISTER) await hub.register(did, input.token, input.platform)
  else await hub.unregister(did, input.token)
  return new Response(null, {status: 200})
}

/** A trusted service (prism) asks for a check for some accounts. */
async function notify(request: Request, hub: HubApi, sources?: string): Promise<Response> {
  if (request.method !== 'POST') return xrpcError(405, 'InvalidRequest', 'use POST')
  let source: string
  try {
    source = await verifyServiceAuth(request.headers.get('authorization'), NOTIFY)
  } catch (e) {
    const message = e instanceof AuthError ? e.message : 'could not check the token'
    return xrpcError(401, 'AuthenticationRequired', message)
  }
  if (!notifySources(sources).has(source)) {
    return xrpcError(403, 'Forbidden', 'this service may not send notifications')
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return xrpcError(400, 'InvalidRequest', 'expected a JSON body')
  }
  const dids = readNotifyInput(body)
  if (typeof dids === 'string') return xrpcError(400, 'InvalidRequest', dids)
  await hub.notify(dids)
  return new Response(null, {status: 200})
}

async function authed(
  request: Request,
  lxm: string,
): Promise<{did: string} | Response> {
  try {
    return {did: await verifyServiceAuth(request.headers.get('authorization'), lxm)}
  } catch (e) {
    const message = e instanceof AuthError ? e.message : 'could not check the token'
    return xrpcError(401, 'AuthenticationRequired', message)
  }
}

async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

/** A signed-in account sends a report. */
async function feedbackSubmit(request: Request, store: FeedbackApi): Promise<Response> {
  if (request.method !== 'POST') return xrpcError(405, 'InvalidRequest', 'use POST')
  const who = await authed(request, FEEDBACK_SUBMIT)
  if (who instanceof Response) return who
  const input = readFeedbackInput(await jsonBody(request))
  if (typeof input === 'string') return xrpcError(400, 'InvalidRequest', input)
  const result = await store.submit(who.did, input)
  if (result === 'rate-limited') {
    return xrpcError(429, 'RateLimitExceeded', 'too many reports today; try again tomorrow')
  }
  return json(result)
}

/** An admin reads reports, newest first. */
async function feedbackList(
  request: Request,
  store: FeedbackApi,
  admins: Set<string>,
): Promise<Response> {
  if (request.method !== 'GET') return xrpcError(405, 'InvalidRequest', 'use GET')
  const who = await authed(request, FEEDBACK_LIST)
  if (who instanceof Response) return who
  if (!admins.has(who.did)) return xrpcError(403, 'Forbidden', 'not a feedback admin')
  const params = new URL(request.url).searchParams
  const limit = Math.min(Math.max(Number(params.get('limit')) || 50, 1), FEEDBACK_LIST_MAX)
  const cursorParam = params.get('cursor')
  const cursor = cursorParam && /^\d+$/.test(cursorParam) ? Number(cursorParam) : undefined
  const doneParam = params.get('done')
  const done = doneParam === 'true' ? true : doneParam === 'false' ? false : undefined
  const page = await store.list({limit, cursor, done})
  return json({
    items: page.items,
    ...(page.cursor !== undefined ? {cursor: String(page.cursor)} : {}),
  })
}

/** An admin marks a report done, or not. */
async function feedbackUpdate(
  request: Request,
  store: FeedbackApi,
  admins: Set<string>,
): Promise<Response> {
  if (request.method !== 'POST') return xrpcError(405, 'InvalidRequest', 'use POST')
  const who = await authed(request, FEEDBACK_UPDATE)
  if (who instanceof Response) return who
  if (!admins.has(who.did)) return xrpcError(403, 'Forbidden', 'not a feedback admin')
  const body = (await jsonBody(request)) as {id?: unknown; done?: unknown} | undefined
  if (typeof body?.id !== 'number' || typeof body.done !== 'boolean') {
    return xrpcError(400, 'InvalidRequest', 'expected {id, done}')
  }
  if (!(await store.setDone(body.id, body.done))) {
    return xrpcError(404, 'NotFound', 'no such report')
  }
  return new Response(null, {status: 200})
}

/** What the routes are given besides the hub. */
export type RouteOptions = {
  /** The NOTIFY_SOURCES setting. */
  sources?: string
  /** The feedback store, where this server keeps reports. */
  feedback?: FeedbackApi
  /** The FEEDBACK_ADMINS setting. */
  admins?: string
}

/** Answer one request. */
export async function handleRequest(
  request: Request,
  hub: HubApi,
  {sources, feedback, admins}: RouteOptions = {},
): Promise<Response> {
  const {pathname} = new URL(request.url)
  if (feedback) {
    switch (pathname) {
      case `/xrpc/${FEEDBACK_SUBMIT}`:
        return feedbackSubmit(request, feedback)
      case `/xrpc/${FEEDBACK_LIST}`:
        return feedbackList(request, feedback, feedbackAdmins(admins))
      case `/xrpc/${FEEDBACK_UPDATE}`:
        return feedbackUpdate(request, feedback, feedbackAdmins(admins))
    }
  }
  switch (pathname) {
    case '/.well-known/did.json':
      return json(DID_DOC)
    case `/xrpc/${REGISTER}`:
      return pushMethod(request, hub, REGISTER)
    case `/xrpc/${UNREGISTER}`:
      return pushMethod(request, hub, UNREGISTER)
    case `/xrpc/${NOTIFY}`:
      return notify(request, hub, sources)
    case '/status':
      return json(await hub.status())
    case '/':
      return new Response('Horizon push service\n', {
        headers: {'content-type': 'text/plain; charset=utf-8'},
      })
    default:
      return xrpcError(404, 'NotFound', 'not found')
  }
}

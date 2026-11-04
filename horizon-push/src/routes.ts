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

/** Answer one request. `sources` is the NOTIFY_SOURCES setting. */
export async function handleRequest(
  request: Request,
  hub: HubApi,
  sources?: string,
): Promise<Response> {
  const {pathname} = new URL(request.url)
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

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/*
 * The push service on Node, behind a reverse proxy that terminates TLS.
 * Settings come from the environment:
 *
 *   PUSH_HOST        listen address (default 127.0.0.1)
 *   PUSH_PORT        listen port (default 8790)
 *   PUSH_DB          SQLite file (default /var/lib/horizon-push/push.db)
 *   PUSH_FCM_FILE    the Firebase service account JSON; under systemd,
 *                    $CREDENTIALS_DIRECTORY/fcm.json by default
 *   NOTIFY_SOURCES   comma-separated DIDs allowed to call notify
 *   PUSH_FEEDBACK_DB feedback SQLite file (default
 *                    /var/lib/horizon-push/feedback.db)
 *   FEEDBACK_ADMINS  comma-separated DIDs allowed to read feedback
 */

import {readFileSync} from 'node:fs'
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http'
import {join} from 'node:path'

import {handleRequest} from '../routes'
import {FeedbackStore} from './feedback'
import {NodeHub} from './hub'

/** The largest request body read. */
const MAX_BODY = 64 * 1024

const host = process.env.PUSH_HOST ?? '127.0.0.1'
const port = Number(process.env.PUSH_PORT ?? 8790)
const dbPath = process.env.PUSH_DB ?? '/var/lib/horizon-push/push.db'
const fcmFile =
  process.env.PUSH_FCM_FILE ??
  (process.env.CREDENTIALS_DIRECTORY ? join(process.env.CREDENTIALS_DIRECTORY, 'fcm.json') : '')
if (!fcmFile) throw new Error('set PUSH_FCM_FILE or run under systemd with LoadCredential=fcm.json')

const hub = new NodeHub({dbPath, fcmServiceAccount: readFileSync(fcmFile, 'utf8')})
const feedback = new FeedbackStore(
  process.env.PUSH_FEEDBACK_DB ?? '/var/lib/horizon-push/feedback.db',
)

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) return undefined
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

async function answer(req: IncomingMessage, res: ServerResponse) {
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req)
  if (body === undefined && req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(413).end()
    return
  }
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value)
    else if (Array.isArray(value)) headers.set(name, value.join(', '))
  }
  const request = new Request(`https://push.nearhorizon.app${req.url ?? '/'}`, {
    method: req.method,
    headers,
    body: body && body.length > 0 ? new Uint8Array(body) : undefined,
  })
  const response = await handleRequest(request, hub, {
    sources: process.env.NOTIFY_SOURCES,
    feedback,
    admins: process.env.FEEDBACK_ADMINS,
  })
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(Buffer.from(await response.arrayBuffer()))
}

const server = createServer((req, res) => {
  answer(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})

server.listen(port, host, () => {
  console.log(`horizon-push listening on ${host}:${port}`)
  void hub.start()
})

function shutdown() {
  server.close()
  hub.stop()
  feedback.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Firebase Cloud Messaging (HTTP v1). Messages are data-only: they carry no
 * text, just which account should check, and the app fetches and shows the
 * notifications itself with its own sign-in.
 */

type ServiceAccount = {
  project_id: string
  client_email: string
  private_key: string
  token_uri?: string
}

export type SendResult = 'sent' | 'gone' | 'retry' | 'failed'

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token'

export function parseServiceAccount(json: string): ServiceAccount {
  const sa = JSON.parse(json) as Partial<ServiceAccount>
  if (!sa.project_id || !sa.client_email || !sa.private_key) {
    throw new Error('the service account is missing fields')
  }
  return sa as ServiceAccount
}

function b64url(bytes: Uint8Array | string): string {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
  let bin = ''
  for (const b of data) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function pemBody(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** The message for one phone: data only, high priority so it wakes the app. */
export function buildMessage(token: string, did: string) {
  return {
    message: {
      token,
      data: {kind: 'check', did},
      android: {
        priority: 'HIGH',
        ttl: '3600s',
        // A phone that was offline gets one wake per account, not a backlog
        collapse_key: `check-${did}`.slice(0, 200),
      },
    },
  }
}

export class Fcm {
  private sa: ServiceAccount
  private accessToken?: {value: string; expires: number}

  constructor(serviceAccountJson: string) {
    this.sa = parseServiceAccount(serviceAccountJson)
  }

  private async token(): Promise<string> {
    const now = Date.now()
    if (this.accessToken && this.accessToken.expires - 60_000 > now) {
      return this.accessToken.value
    }
    const iat = Math.floor(now / 1000)
    const tokenUri = this.sa.token_uri ?? DEFAULT_TOKEN_URI
    const unsigned = `${b64url(JSON.stringify({alg: 'RS256', typ: 'JWT'}))}.${b64url(
      JSON.stringify({
        iss: this.sa.client_email,
        scope: SCOPE,
        aud: tokenUri,
        iat,
        exp: iat + 3600,
      }),
    )}`
    const key = await crypto.subtle.importKey(
      'pkcs8',
      pemBody(this.sa.private_key),
      {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'},
      false,
      ['sign'],
    )
    const sig = new Uint8Array(
      await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)),
    )
    const res = await fetch(tokenUri, {
      method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${b64url(sig)}`,
      }),
    })
    if (!res.ok) throw new Error(`Google sign-in failed (HTTP ${res.status})`)
    const body = (await res.json()) as {access_token?: string; expires_in?: number}
    if (!body.access_token) throw new Error('Google sign-in returned no token')
    this.accessToken = {
      value: body.access_token,
      expires: now + (body.expires_in ?? 3600) * 1000,
    }
    return body.access_token
  }

  async send(token: string, did: string): Promise<SendResult> {
    let access: string
    try {
      access = await this.token()
    } catch {
      return 'retry'
    }
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${this.sa.project_id}/messages:send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${access}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(buildMessage(token, did)),
      },
    )
    if (res.ok) return 'sent'
    return classifyFailure(res.status, await res.text().catch(() => ''))
  }
}

/** What a failed send means for the stored token. */
export function classifyFailure(status: number, body: string): SendResult {
  // The app was uninstalled or the token rotated
  if (status === 404 || body.includes('UNREGISTERED')) return 'gone'
  // A token Firebase does not recognise (INVALID_ARGUMENT on the token)
  if (status === 400 && body.includes('registration token')) return 'gone'
  if (status === 429 || status >= 500) return 'retry'
  return 'failed'
}

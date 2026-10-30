/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {DurableObject} from 'cloudflare:workers'

import {
  JETSTREAM_HOSTS,
  MAX_RESUME_AGE_US,
  MAX_TOKENS_PER_ACCOUNT,
  NUDGE_COOLDOWN_MS,
  NUDGE_DELAY_MS,
  RESUME_OVERLAP_US,
  WANTED_COLLECTIONS,
} from './config'
import {cursorOf, targetsOf} from './events'
import {Fcm} from './fcm'

export type Env = {
  HUB: DurableObjectNamespace<Hub>
  FCM_SERVICE_ACCOUNT: string
}

/** How often the watchdog alarm checks the stream. */
const WATCHDOG_MS = 60_000
/** No event for this long means the stream is stuck. */
const STALL_MS = 90_000
/** How often pending nudges are sent and the cursor saved. */
const TICK_MS = 1_000
const SAVE_EVERY_MS = 10_000

/**
 * The one hub: phones by account (SQLite), the Jetstream listener, and the
 * nudge queue. A single instance, so every registration and every event
 * meet in one place.
 */
export class Hub extends DurableObject<Env> {
  private sql: SqlStorage
  private accounts = new Set<string>()
  private ws?: WebSocket
  private connecting = false
  private hostIndex = 0
  private failures = 0
  private cursor?: number
  private savedCursor?: number
  private lastSave = 0
  private lastEventAt = 0
  private connectedAt = 0
  private ticker?: ReturnType<typeof setInterval>
  /** Account -> when its first unsent event arrived. */
  private pending = new Map<string, number>()
  /** Account -> when it was last nudged. */
  private lastSent = new Map<string, number>()
  private fcm?: Fcm
  private stats = {events: 0, notified: 0, nudges: 0, sends: 0, gone: 0, failed: 0}

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS phones (
        did TEXT NOT NULL,
        token TEXT NOT NULL,
        platform TEXT NOT NULL,
        updated INTEGER NOT NULL,
        PRIMARY KEY (did, token)
      )`)
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      )
      for (const row of this.sql.exec<{did: string}>(`SELECT DISTINCT did FROM phones`)) {
        this.accounts.add(row.did)
      }
      const saved = this.sql
        .exec<{value: string}>(`SELECT value FROM state WHERE key = 'cursor'`)
        .toArray()[0]
      if (saved) this.cursor = this.savedCursor = Number(saved.value)
    })
  }

  // Registrations

  async register(did: string, token: string, platform: string): Promise<void> {
    this.sql.exec(
      `INSERT INTO phones (did, token, platform, updated) VALUES (?, ?, ?, ?)
       ON CONFLICT (did, token) DO UPDATE SET platform = excluded.platform, updated = excluded.updated`,
      did,
      token,
      platform,
      Date.now(),
    )
    // Keep the newest few phones per account
    this.sql.exec(
      `DELETE FROM phones WHERE did = ? AND token NOT IN (
         SELECT token FROM phones WHERE did = ? ORDER BY updated DESC LIMIT ?
       )`,
      did,
      did,
      MAX_TOKENS_PER_ACCOUNT,
    )
    this.accounts.add(did)
    await this.ensureRunning()
  }

  async unregister(did: string, token: string): Promise<void> {
    this.sql.exec(`DELETE FROM phones WHERE did = ? AND token = ?`, did, token)
    this.forgetIfEmpty(did)
  }

  private forgetIfEmpty(did: string) {
    const left = this.sql
      .exec<{n: number}>(`SELECT COUNT(*) AS n FROM phones WHERE did = ?`, did)
      .one().n
    if (left === 0) {
      this.accounts.delete(did)
      this.pending.delete(did)
    }
  }

  /** A trusted service reports activity for these accounts. */
  async notify(dids: string[]): Promise<void> {
    const now = Date.now()
    for (const did of dids) {
      if (this.accounts.has(did) && !this.pending.has(did)) {
        this.pending.set(did, now)
        this.stats.notified++
      }
    }
    await this.ensureRunning()
  }

  // Health

  async status() {
    const now = Date.now()
    return {
      connected: Boolean(this.ws),
      accounts: this.accounts.size,
      lagSeconds: this.cursor ? Math.round((now * 1000 - this.cursor) / 1e6) : null,
      secondsSinceEvent: this.lastEventAt ? Math.round((now - this.lastEventAt) / 1000) : null,
      upSeconds: this.connectedAt ? Math.round((now - this.connectedAt) / 1000) : 0,
      host: JETSTREAM_HOSTS[this.hostIndex],
      ...this.stats,
    }
  }

  // Listener

  async ensureRunning(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS)
    }
    if (this.accounts.size === 0) {
      // Nobody to nudge: no need to hold the stream open
      this.disconnect()
      return
    }
    const stalled = this.ws && this.lastEventAt && Date.now() - this.lastEventAt > STALL_MS
    if (stalled) this.disconnect()
    if (!this.ws && !this.connecting) await this.openStream()
    if (!this.ticker) this.ticker = setInterval(() => void this.tick(), TICK_MS)
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS)
    await this.ensureRunning()
    await this.tick()
  }

  private url(): string {
    const params = new URLSearchParams()
    for (const c of WANTED_COLLECTIONS) params.append('wantedCollections', c)
    const nowUs = Date.now() * 1000
    if (this.cursor && nowUs - this.cursor < MAX_RESUME_AGE_US) {
      params.set('cursor', String(this.cursor - RESUME_OVERLAP_US))
    }
    return `https://${JETSTREAM_HOSTS[this.hostIndex]}/subscribe?${params}`
  }

  private async openStream(): Promise<void> {
    this.connecting = true
    try {
      const res = await fetch(this.url(), {headers: {Upgrade: 'websocket'}})
      const ws = res.webSocket
      if (!ws) throw new Error(`no websocket (HTTP ${res.status})`)
      ws.accept()
      this.ws = ws
      this.failures = 0
      this.connectedAt = Date.now()
      this.lastEventAt = Date.now()
      ws.addEventListener('message', e => this.onMessage(e.data))
      ws.addEventListener('close', () => this.dropped(ws))
      ws.addEventListener('error', () => this.dropped(ws))
    } catch {
      this.failures++
      this.hostIndex = (this.hostIndex + 1) % JETSTREAM_HOSTS.length
    } finally {
      this.connecting = false
    }
  }

  private dropped(ws: WebSocket) {
    if (this.ws !== ws) return
    this.ws = undefined
    this.connectedAt = 0
    // Reconnect soon; the watchdog alarm is the backstop
    const wait = Math.min(1_000 * 2 ** this.failures, 30_000)
    setTimeout(() => void this.ensureRunning(), wait)
  }

  private disconnect() {
    const ws = this.ws
    this.ws = undefined
    this.connectedAt = 0
    try {
      ws?.close(1000, 'restart')
    } catch {
      // already closed
    }
  }

  private onMessage(data: unknown) {
    if (typeof data !== 'string') return
    let event: unknown
    try {
      event = JSON.parse(data)
    } catch {
      return
    }
    this.lastEventAt = Date.now()
    this.stats.events++
    const cursor = cursorOf(event)
    if (cursor && (!this.cursor || cursor > this.cursor)) this.cursor = cursor
    for (const did of targetsOf(event)) {
      if (this.accounts.has(did) && !this.pending.has(did)) {
        this.pending.set(did, Date.now())
      }
    }
  }

  // Nudges

  private async tick(): Promise<void> {
    const now = Date.now()
    if (this.cursor && this.cursor !== this.savedCursor && now - this.lastSave > SAVE_EVERY_MS) {
      this.sql.exec(
        `INSERT INTO state (key, value) VALUES ('cursor', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        String(this.cursor),
      )
      this.savedCursor = this.cursor
      this.lastSave = now
    }
    for (const [did, sent] of this.lastSent) {
      if (now - sent > NUDGE_COOLDOWN_MS) this.lastSent.delete(did)
    }
    const due: string[] = []
    for (const [did, first] of this.pending) {
      const cooled = now - (this.lastSent.get(did) ?? 0) >= NUDGE_COOLDOWN_MS
      if (now - first >= NUDGE_DELAY_MS && cooled) due.push(did)
    }
    for (const did of due) {
      this.pending.delete(did)
      this.lastSent.set(did, now)
      await this.nudge(did)
    }
  }

  private async nudge(did: string): Promise<void> {
    this.fcm ??= new Fcm(this.env.FCM_SERVICE_ACCOUNT)
    const phones = this.sql
      .exec<{token: string}>(`SELECT token FROM phones WHERE did = ?`, did)
      .toArray()
    this.stats.nudges++
    for (const {token} of phones) {
      const result = await this.fcm.send(token, did)
      if (result === 'sent') this.stats.sends++
      else if (result === 'gone') {
        this.stats.gone++
        this.sql.exec(`DELETE FROM phones WHERE did = ? AND token = ?`, did, token)
      } else this.stats.failed++
    }
    this.forgetIfEmpty(did)
  }
}

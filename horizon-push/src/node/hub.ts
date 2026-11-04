/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {DatabaseSync, type SQLInputValue} from 'node:sqlite'


import {
  JETSTREAM_HOSTS,
  MAX_RESUME_AGE_US,
  MAX_TOKENS_PER_ACCOUNT,
  FOLLOW_UP_MS,
  MAX_EVENTS_PER_NUDGE,
  NUDGE_COOLDOWN_MS,
  NUDGE_DELAY_MS,
  RESUME_OVERLAP_US,
  WANTED_COLLECTIONS,
} from '../config'
import {cursorOf, type Notice, noticesOf} from '../events'
import {Fcm} from '../fcm'
import {type HubApi} from '../routes'


/** How often the watchdog alarm checks the stream. */
const WATCHDOG_MS = 60_000
/** No event for this long means the stream is stuck. */
const STALL_MS = 90_000
/** How often pending nudges are sent and the cursor saved. */
const TICK_MS = 1_000
const SAVE_EVERY_MS = 10_000

/** The rows of one statement, shaped like a Durable Object's cursor. */
type Rows<T> = {toArray(): T[]; one(): T; [Symbol.iterator](): Iterator<T>}

/** A Durable Object `SqlStorage`-like `exec` over `node:sqlite`. */
class Sql {
  constructor(private db: DatabaseSync) {}

  exec<T = Record<string, unknown>>(query: string, ...params: SQLInputValue[]): Rows<T> {
    const stmt = this.db.prepare(query)
    let rows: T[] = []
    if (/^\s*(SELECT|WITH)\b/i.test(query)) rows = stmt.all(...params) as T[]
    else stmt.run(...params)
    return {
      toArray: () => rows,
      one: () => {
        if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`)
        return rows[0] as T
      },
      [Symbol.iterator]: () => rows[Symbol.iterator](),
    }
  }
}

/** How long a Jetstream connection may take to open. */
const OPEN_TIMEOUT_MS = 15_000

/**
 * The one hub, on Node: phones by account (SQLite file), the Jetstream
 * listener, and the nudge queue. The Durable Object version's logic, with a
 * watchdog timer in place of its alarm.
 */
export class NodeHub implements HubApi {
  private db: DatabaseSync
  private sql: Sql
  private watchdog?: ReturnType<typeof setInterval>
  private fcmServiceAccount: string
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
  /** Account -> the notices waiting for its next nudge. */
  private notices = new Map<string, Notice[]>()
  /** Account -> when its follow-up nudges are due, earliest first. */
  private followUps = new Map<string, number[]>()
  /** Account -> when it was last nudged. */
  private lastSent = new Map<string, number>()
  private fcm?: Fcm

  /** Whether to open the Jetstream connection (tests leave it closed). */
  private listen: boolean

  constructor({
    dbPath,
    fcmServiceAccount,
    listen = true,
  }: {
    dbPath: string
    fcmServiceAccount: string
    listen?: boolean
  }) {
    this.fcmServiceAccount = fcmServiceAccount
    this.listen = listen
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.sql = new Sql(this.db)
    {
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
    }
  }

  /** Start the watchdog (the Durable Object's alarm) and the listener. */
  async start(): Promise<void> {
    this.watchdog ??= setInterval(() => {
      void this.ensureRunning().then(() => this.tick())
    }, WATCHDOG_MS)
    await this.ensureRunning()
  }

  /** Stop everything and keep the cursor, for a clean shutdown. */
  stop(): void {
    if (this.watchdog) clearInterval(this.watchdog)
    if (this.ticker) clearInterval(this.ticker)
    this.watchdog = this.ticker = undefined
    this.disconnect()
    this.saveCursor(Date.now())
    this.db.close()
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
      this.notices.delete(did)
      this.followUps.delete(did)
    }
  }

  /** A trusted service reports activity for these accounts. */
  async notify(dids: string[]): Promise<void> {
    const now = Date.now()
    for (const did of dids) {
      if (this.accounts.has(did) && !this.pending.has(did)) {
        this.pending.set(did, now)
      }
    }
    await this.ensureRunning()
  }

  // Health

  /**
   * Public health only: no counts of accounts, notifications or sends, which
   * would say something about users' activity (kryphocron included).
   */
  async status() {
    const now = Date.now()
    return {
      connected: Boolean(this.ws),
      lagSeconds: this.cursor ? Math.round((now * 1000 - this.cursor) / 1e6) : null,
      secondsSinceEvent: this.lastEventAt ? Math.round((now - this.lastEventAt) / 1000) : null,
      upSeconds: this.connectedAt ? Math.round((now - this.connectedAt) / 1000) : 0,
      host: JETSTREAM_HOSTS[this.hostIndex],
    }
  }

  // Listener

  async ensureRunning(): Promise<void> {
    if (this.accounts.size === 0) {
      // Nobody to nudge: no need to hold the stream open
      this.disconnect()
      return
    }
    if (!this.listen) return
    const stalled = this.ws && this.lastEventAt && Date.now() - this.lastEventAt > STALL_MS
    if (stalled) this.disconnect()
    if (!this.ws && !this.connecting) await this.openStream()
    if (!this.ticker) this.ticker = setInterval(() => void this.tick(), TICK_MS)
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
      const ws = new WebSocket(this.url())
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('open timed out')), OPEN_TIMEOUT_MS)
        ws.addEventListener('open', () => {
          clearTimeout(timer)
          resolve()
        })
        ws.addEventListener('error', () => {
          clearTimeout(timer)
          reject(new Error('could not open'))
        })
      })
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
    const cursor = cursorOf(event)
    if (cursor && (!this.cursor || cursor > this.cursor)) this.cursor = cursor
    for (const notice of noticesOf(event)) {
      const did = notice.did
      if (!this.accounts.has(did)) continue
      if (!this.pending.has(did)) this.pending.set(did, Date.now())
      const list = this.notices.get(did) ?? []
      // One past the limit is enough to know a check is due instead
      if (list.length <= MAX_EVENTS_PER_NUDGE) list.push(notice)
      this.notices.set(did, list)
    }
  }

  // Nudges

  private saveCursor(now: number) {
    if (!this.cursor || this.cursor === this.savedCursor) return
    this.sql.exec(
      `INSERT INTO state (key, value) VALUES ('cursor', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      String(this.cursor),
    )
    this.savedCursor = this.cursor
    this.lastSave = now
  }

  private async tick(): Promise<void> {
    const now = Date.now()
    if (now - this.lastSave > SAVE_EVERY_MS) this.saveCursor(now)
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
      const notices = this.notices.get(did) ?? []
      this.notices.delete(did)
      this.lastSent.set(did, now)
      this.followUps.set(
        did,
        FOLLOW_UP_MS.map(delay => now + delay),
      )
      await this.nudge(
        did,
        notices.length > 0 && notices.length <= MAX_EVENTS_PER_NUDGE ? notices : [],
      )
    }
    for (const [did, times] of this.followUps) {
      if (this.pending.has(did)) continue
      const cooled = now - (this.lastSent.get(did) ?? 0) >= NUDGE_COOLDOWN_MS
      if (times[0] === undefined || times[0] > now || !cooled) continue
      times.shift()
      if (times.length === 0) this.followUps.delete(did)
      if (!this.accounts.has(did)) {
        this.followUps.delete(did)
        continue
      }
      this.lastSent.set(did, now)
      await this.nudge(did)
    }
  }

  /**
   * Wake `did`'s phones: one event message per notice, or one check when
   * there are none (a notify, or more than fit in one burst).
   */
  private async nudge(did: string, notices: Notice[] = []): Promise<void> {
    this.fcm ??= new Fcm(this.fcmServiceAccount)
    const phones = this.sql
      .exec<{token: string}>(`SELECT token FROM phones WHERE did = ?`, did)
      .toArray()
    const results: string[] = []
    for (const {token} of phones) {
      let gone = false
      for (const notice of notices.length > 0 ? notices : [undefined]) {
        const result = await this.fcm.send(token, did, notice)
        results.push(result)
        if (result === 'gone') {
          gone = true
          break
        }
      }
      if (gone) this.sql.exec(`DELETE FROM phones WHERE did = ? AND token = ?`, did, token)
    }
    // No account or token: only the kind of wake and how it went.
    console.log(`nudge (${notices.length > 0 ? `${notices.length} event` : 'check'}): ${results.join(', ') || 'no phones'}`)
    this.forgetIfEmpty(did)
  }
}

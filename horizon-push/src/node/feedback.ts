/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {DatabaseSync} from 'node:sqlite'

import {
  type FeedbackApi,
  type FeedbackInput,
  type FeedbackItem,
  type FeedbackKind,
  FEEDBACK_PER_DAY,
} from '../feedback'

const DAY_MS = 24 * 60 * 60 * 1000

type Row = {
  id: number
  did: string
  kind: string
  text: string
  details: string | null
  created: number
  done: number
}

/** Feedback reports in their own SQLite file. */
export class FeedbackStore implements FeedbackApi {
  private db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      did TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      details TEXT,
      created INTEGER NOT NULL,
      done INTEGER NOT NULL DEFAULT 0
    )`)
    this.db.exec('CREATE INDEX IF NOT EXISTS feedback_by_sender ON feedback (did, created)')
  }

  async submit(did: string, input: FeedbackInput): Promise<{id: number} | 'rate-limited'> {
    const now = Date.now()
    const {n} = this.db
      .prepare('SELECT COUNT(*) AS n FROM feedback WHERE did = ? AND created > ?')
      .get(did, now - DAY_MS) as {n: number}
    if (n >= FEEDBACK_PER_DAY) return 'rate-limited'
    const result = this.db
      .prepare('INSERT INTO feedback (did, kind, text, details, created) VALUES (?, ?, ?, ?, ?)')
      .run(did, input.kind, input.text, input.details ? JSON.stringify(input.details) : null, now)
    return {id: Number(result.lastInsertRowid)}
  }

  async list({
    limit,
    cursor,
    done,
  }: {
    limit: number
    cursor?: number
    done?: boolean
  }): Promise<{items: FeedbackItem[]; cursor?: number}> {
    const where: string[] = []
    const params: number[] = []
    if (cursor !== undefined) {
      where.push('id < ?')
      params.push(cursor)
    }
    if (done !== undefined) {
      where.push('done = ?')
      params.push(done ? 1 : 0)
    }
    const sql = `SELECT * FROM feedback ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`
    const rows = this.db.prepare(sql).all(...params, limit + 1) as Row[]
    const page = rows.slice(0, limit)
    return {
      items: page.map(row => ({
        id: row.id,
        did: row.did,
        kind: row.kind as FeedbackKind,
        text: row.text,
        ...(row.details ? {details: JSON.parse(row.details) as Record<string, string>} : {}),
        createdAt: new Date(row.created).toISOString(),
        done: row.done === 1,
      })),
      ...(rows.length > limit && page.length > 0 ? {cursor: page[page.length - 1]!.id} : {}),
    }
  }

  async setDone(id: number, done: boolean): Promise<boolean> {
    const result = this.db.prepare('UPDATE feedback SET done = ? WHERE id = ?').run(done ? 1 : 0, id)
    return Number(result.changes) > 0
  }

  close(): void {
    this.db.close()
  }
}

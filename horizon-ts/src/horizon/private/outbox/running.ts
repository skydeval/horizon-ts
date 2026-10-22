/*
 * The outbox's names and this tab's running set (2K design PA-28, K13-N4): a
 * leaf module, importing nothing of the outbox, so a plain module can ask it
 * without bringing in the job, Web Locks, subscriptions or toasts.
 *
 * Built in 2K-9 because the outbox needs the names and the set; 2K-8 adds
 * `findComposeEntry` and `isComposeRunning` here for `hidesAudienceChange`
 * (SQ-20).
 */

/**
 * The device key prefix of one account's outbox records.
 */
export function outboxRecordPrefix(did: string): string {
  return `horizon-outbox:${did}:`
}

/**
 * The device key of one outbox record.
 */
export function outboxRecordKey(did: string, id: string): string {
  return `${outboxRecordPrefix(did)}${id}`
}

/**
 * The Web Lock held by the tab running, deciding or acting on an entry: the
 * one source of the name.
 */
export function runLockName(id: string): string {
  return `horizon-outbox-run:${id}`
}

/**
 * One entry this tab holds the run lock of.
 */
export type RunningEntry = {id: string; did: string; rkeys: readonly string[]}

const running = new Map<string, RunningEntry>()

/**
 * The outbox took `entry`'s run lock.
 */
export function markRunning(entry: RunningEntry) {
  running.set(entry.id, entry)
}

/**
 * The outbox released the run lock of entry `id`.
 */
export function unmarkRunning(id: string) {
  running.delete(id)
}

/**
 * The entries this tab holds the run lock of.
 */
export function runningEntries(): RunningEntry[] {
  return Array.from(running.values())
}

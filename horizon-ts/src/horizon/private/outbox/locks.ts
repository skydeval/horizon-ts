/*
 * The outbox's run locks (2K design PA-28, the run lock): Web Locks taken
 * with `ifAvailable`, so a tab never waits for another tab's lock, and the
 * display-only query of which locks other tabs hold (K9-N5).
 *
 * Without `navigator.locks` (native, jest) a lock is kept in this module, for
 * this tab only. On web the outbox never runs without Web Locks: the posting
 * route is `none` there (`encoderAvailable`).
 */

/**
 * A run lock this tab holds. `release` is idempotent.
 */
export type HeldLock = {release(): void}

type LockManagerLike = {
  request(
    name: string,
    options: {ifAvailable: boolean},
    callback: (lock: unknown) => Promise<void> | undefined,
  ): Promise<unknown>
  query(): Promise<{held?: {name?: string}[]}>
}

function lockManager(): LockManagerLike | undefined {
  const nav = (globalThis as {navigator?: {locks?: LockManagerLike}}).navigator
  return nav?.locks
}

const localLocks = new Set<string>()

/**
 * Locks this tab released whose request has not settled yet: a Web Lock is
 * free only once its request's promise settles, a moment after `release`,
 * so this tab's own next request for it waits for that.
 */
const releasing = new Map<string, Promise<unknown>>()

/**
 * Take the lock `name` if no one holds it; `undefined` when someone does.
 */
export async function tryRunLock(name: string): Promise<HeldLock | undefined> {
  await releasing.get(name)
  return requestLock(name)
}

function requestLock(name: string): Promise<HeldLock | undefined> {
  const locks = lockManager()
  if (!locks) {
    if (localLocks.has(name)) return Promise.resolve(undefined)
    localLocks.add(name)
    let released = false
    return Promise.resolve({
      release() {
        if (released) return
        released = true
        localLocks.delete(name)
      },
    })
  }
  return new Promise(resolve => {
    const request = locks
      .request(name, {ifAvailable: true}, lock => {
        if (!lock) {
          resolve(undefined)
          return undefined
        }
        return new Promise<void>(release => {
          let released = false
          resolve({
            release() {
              if (released) return
              released = true
              const settled = request.then(
                () => undefined,
                () => undefined,
              )
              releasing.set(name, settled)
              void settled.then(() => {
                if (releasing.get(name) === settled) releasing.delete(name)
              })
              release()
            },
          })
        })
      })
      .catch(() => resolve(undefined))
  })
}

/**
 * The names of the locks held now, by any tab, from `navigator.locks.query()`
 * (display only: never an `ifAvailable` probe, which would take the lock for
 * a moment and could turn away that tab's own action). Without Web Locks,
 * this tab's own.
 */
export async function heldLockNames(): Promise<Set<string>> {
  const locks = lockManager()
  if (!locks) return new Set(localLocks)
  try {
    const snapshot = await locks.query()
    return new Set(
      (snapshot.held ?? [])
        .map(lock => lock.name)
        .filter((name): name is string => typeof name === 'string'),
    )
  } catch {
    return new Set()
  }
}

/**
 * Forget the local locks (tests).
 */
export function resetLocalLocks() {
  localLocks.clear()
  releasing.clear()
}

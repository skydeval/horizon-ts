/*
 * The outbox for display: kept current from this tab's changes and other
 * tabs' `storage` events, with the run locks other tabs hold read from
 * `navigator.locks.query()` (display only, K9-N5).
 */

import {useEffect, useState, useSyncExternalStore} from 'react'

import {
  getOutboxVersion,
  heldLockNames,
  listUnsent,
  type OutboxView,
  outboxViewForUri,
  subscribeOutbox,
  watchOutboxRecords,
} from '#/horizon/private/outbox'

/**
 * The outbox's change counter, kept current.
 */
export function useOutboxVersion(): number {
  return useSyncExternalStore(subscribeOutbox, getOutboxVersion)
}

/**
 * The run lock names held now, read again on every outbox change.
 */
export function useHeldLocks(): ReadonlySet<string> {
  const version = useOutboxVersion()
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    let live = true
    void heldLockNames().then(names => {
      if (live) setHeld(names)
    })
    return () => {
      live = false
    }
  }, [version])
  return held
}

/**
 * The account's Unsent entries (8.4), kept current.
 */
export function useUnsent(did: string | undefined): OutboxView[] {
  const version = useOutboxVersion()
  const held = useHeldLocks()
  useEffect(() => {
    if (did) watchOutboxRecords(did)
  }, [did])
  // `version` is read so the list follows every change.
  return did && version >= 0 ? listUnsent(did, held) : []
}

/**
 * The outbox entry whose compose holds the pending post `uri`, kept current.
 */
export function useOutboxViewForUri(
  did: string | undefined,
  uri: string,
): OutboxView | undefined {
  const version = useOutboxVersion()
  const held = useHeldLocks()
  return did && version >= 0 ? outboxViewForUri(did, uri, held) : undefined
}

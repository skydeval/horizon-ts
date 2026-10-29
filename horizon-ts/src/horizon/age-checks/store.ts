/*
 * The device's last answer from the store, kept in device storage so it
 * holds across launches, with a subscribe for React
 * (`useSyncExternalStore`, so the React Compiler never caches a stale read).
 */

import {useSyncExternalStore} from 'react'

import {type StoredAgeCheck} from '#/horizon/age-checks/types'
import {device} from '#/storage'

const listeners = new Set<() => void>()
let current: StoredAgeCheck | undefined

let loaded = false
function load() {
  if (loaded) return
  loaded = true
  current = device.get(['horizonAgeCheck'])
}

export function getAgeCheck(): StoredAgeCheck | undefined {
  load()
  return current
}

export function setAgeCheck(next: StoredAgeCheck | undefined) {
  load()
  current = next
  device.set(['horizonAgeCheck'], next)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useStoredAgeCheck(): StoredAgeCheck | undefined {
  return useSyncExternalStore(subscribe, getAgeCheck, getAgeCheck)
}

/*
 * Asking the store, one request at a time. `checking` is true while one is
 * out, so buttons can show it.
 */
let checking = false
let inFlight: Promise<void> | null = null

function getChecking() {
  return checking
}

function setChecking(next: boolean) {
  checking = next
  for (const listener of listeners) listener()
}

export function useAgeCheckBusy(): boolean {
  return useSyncExternalStore(subscribe, getChecking, getChecking)
}

/**
 * Runs `ask` with the last answer and keeps what it returns. A request
 * already out is joined rather than doubled.
 */
export function runAgeCheck(
  ask: (previous: StoredAgeCheck | undefined) => Promise<StoredAgeCheck | undefined>,
): Promise<void> {
  if (inFlight) return inFlight
  setChecking(true)
  inFlight = ask(getAgeCheck())
    .then(next => {
      if (next) setAgeCheck(next)
    })
    .finally(() => {
      inFlight = null
      setChecking(false)
    })
  return inFlight
}

/** Tests only: forget what was loaded. */
export function resetAgeCheckStoreForTests() {
  loaded = false
  current = undefined
  checking = false
  inFlight = null
  listeners.clear()
}

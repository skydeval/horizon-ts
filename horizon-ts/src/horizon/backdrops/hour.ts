/*
 * The local hour, for the "Time of day" sky (change list 2, item 3). One
 * timer, armed only while something follows the hour, fires just after the
 * next hour begins; the sky then switches once, with no transition. The
 * timer is re-armed from the clock each time, so a sleeping device or a
 * changed time zone catches up on the next tick or the next visit.
 */

import {useSyncExternalStore} from 'react'

const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | null = null
let hour = new Date().getHours()

/** Milliseconds from `now` to just after the next hour begins. */
export function msToNextHour(now: Date): number {
  const next = new Date(now)
  next.setHours(now.getHours() + 1, 0, 0, 0)
  // A second late, so the new hour has surely begun.
  return next.getTime() - now.getTime() + 1000
}

function arm() {
  timer = setTimeout(() => {
    timer = null
    const now = new Date().getHours()
    if (now !== hour) {
      hour = now
      listeners.forEach(listener => listener())
    }
    if (listeners.size > 0) arm()
  }, msToNextHour(new Date()))
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  // The hour may have changed while nothing followed it.
  hour = new Date().getHours()
  if (!timer) arm()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) {
      clearTimeout(timer)
      timer = null
    }
  }
}

function noSubscribe() {
  return () => {}
}

function getHour() {
  return hour
}

/**
 * The local hour (0-23), followed live only when `follow` is true; other
 * callers get the hour as last read and arm no timer.
 */
export function useHour(follow: boolean): number {
  return useSyncExternalStore(
    follow ? subscribe : noSubscribe,
    getHour,
    getHour,
  )
}

/** Tests only. */
export function resetHourForTests() {
  if (timer) clearTimeout(timer)
  timer = null
  listeners.clear()
  hour = new Date().getHours()
}

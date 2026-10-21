/*
 * The local month, for "Follow the season" (change list 3, item 4). Like
 * the hour clock (`hour.ts`): one timer, armed only while something follows
 * the season, fires just after the next local midnight; the backdrop then
 * switches once if the month changed, with no transition. Re-armed from the
 * clock each time, so a sleeping device catches up on the next tick or the
 * next visit.
 */

import {useSyncExternalStore} from 'react'

const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | null = null
let month = new Date().getMonth()

/** Milliseconds from `now` to just after the next local midnight. */
export function msToNextDay(now: Date): number {
  const next = new Date(now)
  next.setHours(24, 0, 0, 0)
  // A second late, so the new day has surely begun.
  return next.getTime() - now.getTime() + 1000
}

function arm() {
  timer = setTimeout(() => {
    timer = null
    const now = new Date().getMonth()
    if (now !== month) {
      month = now
      listeners.forEach(listener => listener())
    }
    if (listeners.size > 0) arm()
  }, msToNextDay(new Date()))
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  // The month may have changed while nothing followed it.
  month = new Date().getMonth()
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

function getMonth() {
  return month
}

/**
 * The local month (0-11), followed live only when `follow` is true; other
 * callers get the month as last read and arm no timer.
 */
export function useMonth(follow: boolean): number {
  return useSyncExternalStore(
    follow ? subscribe : noSubscribe,
    getMonth,
    getMonth,
  )
}

/** Tests only. */
export function resetMonthForTests() {
  if (timer) clearTimeout(timer)
  timer = null
  listeners.clear()
  month = new Date().getMonth()
}

/*
 * One announcer for every platform (system accounts design 4.6, SAR1-L13,
 * SAR2-N11). `AccessibilityInfo.announceForAccessibility` is a no-op on web,
 * so web and Android speak through a pair of live regions mounted empty at
 * start-up (`Announcer.tsx`), and iOS through the system announcement.
 *
 * - A message is written 150 ms after it is queued (not on the next frame,
 *   which NVDA can miss).
 * - Each region has two text nodes; a message goes into the empty one while
 *   the other is cleared, so a repeated message is a change and is spoken.
 * - While something holds the announcer (the Posting as menu, whose modal
 *   hides the rest of the page from assistive technology), messages wait
 *   and are written once it lets go.
 */

import {AccessibilityInfo} from 'react-native'

import {IS_IOS} from '#/env'

export type AnnouncementKind = 'polite' | 'alert'

export type AnnouncerState = {
  polite: [string, string]
  alert: [string, string]
}

/** How long after queueing a message is written. */
export const ANNOUNCE_DELAY_MS = 150

let state: AnnouncerState = {polite: ['', ''], alert: ['', '']}
const listeners = new Set<() => void>()
const queue: {message: string; kind: AnnouncementKind}[] = []
let holds = 0
let timer: ReturnType<typeof setTimeout> | undefined

function notify() {
  listeners.forEach(listener => listener())
}

let forcedSpeaker: ((message: string) => void) | 'regions' | undefined

/**
 * Test-only: behave as on iOS, speaking through a function in place of the
 * system announcement, or as on web and Android (`'regions'`); undefined
 * resets.
 */
export function setSystemSpeakerForTests(
  next?: ((message: string) => void) | 'regions',
) {
  forcedSpeaker = next
}

function write(message: string, kind: AnnouncementKind) {
  if (typeof forcedSpeaker === 'function') {
    forcedSpeaker(message)
    return
  }
  if (IS_IOS && forcedSpeaker !== 'regions') {
    AccessibilityInfo.announceForAccessibility(message)
    return
  }
  const next: [string, string] = state[kind][0] ? ['', message] : [message, '']
  state = {...state, [kind]: next}
  notify()
}

function flushSoon() {
  if (timer || holds > 0 || !queue.length) return
  timer = setTimeout(() => {
    timer = undefined
    if (holds > 0) return
    const items = queue.splice(0)
    for (const item of items) write(item.message, item.kind)
  }, ANNOUNCE_DELAY_MS)
}

/**
 * Speak `message`: politely, or as an alert for a failure. Each message is
 * also shown as text where it happened; this is for the moments the user
 * may not be looking (a result after its dialog closed).
 */
export function announce(message: string, kind: AnnouncementKind = 'polite') {
  if (!message) return
  queue.push({message, kind})
  flushSoon()
}

/** Hold messages until the returned release is called (once). */
export function holdAnnouncements(): () => void {
  holds++
  let released = false
  return () => {
    if (released) return
    released = true
    holds = Math.max(0, holds - 1)
    flushSoon()
  }
}

/** The regions' text, for `Announcer.tsx`. */
export function getAnnouncerState(): AnnouncerState {
  return state
}

/** Subscribe to the regions' text. Returns the unsubscribe function. */
export function subscribeAnnouncer(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test-only: empty the regions, the queue and the holds. */
export function resetAnnouncerForTests() {
  if (timer) clearTimeout(timer)
  timer = undefined
  queue.length = 0
  holds = 0
  state = {polite: ['', ''], alert: ['', '']}
  notify()
}

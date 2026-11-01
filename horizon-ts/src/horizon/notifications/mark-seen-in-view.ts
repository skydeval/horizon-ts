/*
 * Marking notifications seen only while someone can see them.
 *
 * The notifications screen marks what it loads as seen. A screen can load
 * while nobody is looking at it: a browser tab left on Notifications, a
 * screen kept mounted under another one, or the app in the background. Marking
 * there clears the badge and the unread tint for notifications nobody read. So
 * a mark asked for out of view waits, and is sent once the screen is focused
 * and the tab or app is in the foreground. Several waiting marks become one,
 * up to the latest time asked for.
 */

import {useEffect, useRef, useState} from 'react'
import {AppState} from 'react-native'
import {useIsFocused} from '@react-navigation/native'

/**
 * Marks held until the screen is in view.
 */
export type PendingSeen = {
  /**
   * Sends the mark now if `inView`, otherwise holds it.
   */
  request: (at: Date, inView: boolean) => void
  /**
   * Sends the held mark, if any, when `inView`.
   */
  flush: (inView: boolean) => void
}

export function createPendingSeen(send: (at: Date) => void): PendingSeen {
  let pending: Date | undefined
  const later = (a: Date | undefined, b: Date) =>
    a && a.getTime() > b.getTime() ? a : b
  return {
    request(at, inView) {
      if (inView) {
        const next = later(pending, at)
        pending = undefined
        send(next)
      } else {
        pending = later(pending, at)
      }
    },
    flush(inView) {
      if (!inView || !pending) return
      const next = pending
      pending = undefined
      send(next)
    },
  }
}

/**
 * Whether the app (native) or the browser tab (web) is in the foreground.
 */
export function useAppIsActive(): boolean {
  const [active, setActive] = useState(() => AppState.currentState === 'active')
  useEffect(() => {
    setActive(AppState.currentState === 'active')
    const sub = AppState.addEventListener('change', state =>
      setActive(state === 'active'),
    )
    return () => sub.remove()
  }, [])
  return active
}

/**
 * Whether the screen is focused and the app or tab is in the foreground.
 */
export function useIsScreenInView(): boolean {
  const isFocused = useIsFocused()
  const active = useAppIsActive()
  return isFocused && active
}

/**
 * Returns a function that marks notifications seen up to a time, now if the
 * screen is in view, otherwise as soon as it comes into view.
 */
export function useMarkSeenInView(
  send: (at: Date) => void,
): (at: Date) => void {
  const inView = useIsScreenInView()
  const inViewRef = useRef(inView)
  const sendRef = useRef(send)
  useEffect(() => {
    sendRef.current = send
  })
  const [pending] = useState(() =>
    createPendingSeen(at => sendRef.current(at)),
  )
  useEffect(() => {
    inViewRef.current = inView
    pending.flush(inView)
  }, [inView, pending])
  return (at: Date) => pending.request(at, inViewRef.current)
}

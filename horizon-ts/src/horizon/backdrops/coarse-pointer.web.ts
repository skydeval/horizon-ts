import {useSyncExternalStore} from 'react'

const QUERY = '(pointer: coarse)'

function mediaQuery(): MediaQueryList | undefined {
  if (typeof window === 'undefined' || !window.matchMedia) return undefined
  return window.matchMedia(QUERY)
}

function subscribe(onChange: () => void): () => void {
  const mql = mediaQuery()
  if (!mql) return () => {}
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

function getSnapshot(): boolean {
  return mediaQuery()?.matches ?? false
}

function getServerSnapshot(): boolean {
  return false
}

/**
 * Whether the device is touch-first (`(pointer: coarse)`), live: a tablet
 * that attaches a mouse or a laptop that detaches its screen updates it.
 */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

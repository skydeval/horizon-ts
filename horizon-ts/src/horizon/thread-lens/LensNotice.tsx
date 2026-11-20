/*
 * Thread Lens's notice under the anchor (Phase 4 design 10, 11.3; hook
 * TH-8) shows nothing (skydeval, 2026-11-20: "absolutely under no
 * circumstances have that thing show up. just casually try again until it
 * loads every few seconds"). The thread shows as it normally appears, and
 * while the lens is in a state the notice would have offered Try again for
 * (a failed read, a kept snapshot, bridging off), it reads the thread again
 * every few seconds, quietly, until the lens answers. Never while the
 * account's 429 wait runs.
 *
 * It lives in the anchor's list item, so windowing that unmounts the anchor
 * pauses the retries; scrolling back resumes them.
 */

import {useEffect} from 'react'

import {useSession} from '#/state/session'
import {THREAD_LENS} from '#/horizon/switches'
import {type LensState} from '#/horizon/thread-lens/adapt'
import {useLensWaiting} from '#/horizon/thread-lens/api'
import {lensNoticeLines} from '#/horizon/thread-lens/notice'

/** How often a thread is read again while the lens hasn't answered. */
export const LENS_RETRY_MS = 4_000

/** Renders nothing; retries the lens quietly while it's failing. */
export function ThreadLensNotice({
  lens,
  onRetry,
}: {
  lens: LensState
  onRetry: () => unknown
}) {
  const {currentAccount} = useSession()
  const waiting = useLensWaiting(currentAccount?.did)
  const retrying = THREAD_LENS && lensNoticeLines(lens).some(line => line.retry)
  useEffect(() => {
    if (!retrying || waiting) return
    const timer = setInterval(() => {
      void onRetry()
    }, LENS_RETRY_MS)
    return () => clearInterval(timer)
  }, [retrying, waiting, onRetry])
  return null
}

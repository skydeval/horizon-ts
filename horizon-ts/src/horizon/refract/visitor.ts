/*
 * Visitor-form action hiding (refract client design 9.2, D2, RF-10). prism
 * serves anyone who isn't a ready member in visitor form, and every view in
 * such an answer lacks the reader's `like`, `repost` and `following`, so a
 * tap could write a duplicate. Like, repost (and Quote, which lives in the
 * repost menu, Q2) and follow are hidden:
 *
 * - on a view whose stamp says `'visitor'`, unless prism marked that view's
 *   viewer state as known (`viewerChecked`, RF-S13);
 * - on a view with only a readable marker (Thread Lens) while
 *   `restoredVisitorForm` holds now.
 *
 * A view's stamp never changes, so a visitor view stays hidden until it is
 * refreshed as a member answer. Every call site of the like, repost and
 * follow mutation queues consults `useRestoredActionsHidden`, and the queues
 * refuse such a subject as a backstop (`refuseRestoredAction`). Reply stays.
 */

import {useSyncExternalStore} from 'react'

import {
  refractActive,
  restoredVisitorForm,
  subscribeRefractGate,
} from '#/horizon/refract/gate'
import {readRestored, stampOf, viewerCheckedOf} from '#/horizon/refract/marker'

/** Whether like, repost and follow are hidden on `view` (9.2). */
export function restoredActionsHidden(view: unknown): boolean {
  if (!view || !refractActive()) return false
  const stamp = stampOf(view)
  if (stamp === 'visitor') return !viewerCheckedOf(view)
  if (stamp === 'member') return false
  return !!readRestored(view) && restoredVisitorForm()
}

/** {@link restoredActionsHidden}, re-rendering when the gate changes. */
export function useRestoredActionsHidden(view: unknown): boolean {
  return useSyncExternalStore(subscribeRefractGate, () =>
    restoredActionsHidden(view),
  )
}

/**
 * The mutation queues' backstop: `true` when the subject's action must not
 * be written. The queue then does nothing and keeps its state.
 */
export function refuseRestoredAction(view: unknown): boolean {
  return restoredActionsHidden(view)
}

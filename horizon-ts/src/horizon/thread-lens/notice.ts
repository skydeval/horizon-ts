/*
 * The notice's lines (Phase 4 design 10, 11.3), a pure function of the
 * screen's lens state, apart from the component so it loads without the UI.
 */

import {type MessageDescriptor} from '@lingui/core'

import {type LensState} from '#/horizon/thread-lens/adapt'
import {
  BRIDGING_OFF,
  FALLBACK_NOTE,
  GAP_ONLY_NOTE,
  KEPT_NOTE,
  UNVERIFIED_NOTE,
} from '#/horizon/thread-lens/strings'

/** One line of the notice, and whether it offers Try again. */
export type Line = {text: MessageDescriptor; retry: boolean}

/** The lines the notice shows for `lens`, in order (10, 11.3). */
export function lensNoticeLines(lens: LensState): Line[] {
  const lines: Line[] = []
  const note = lens.note
  const failed = (reason: string): reason is '429' | 'unavailable' =>
    reason === '429' || reason === 'unavailable'
  if (lens.kind === 'fallback' && note && failed(note.reason)) {
    lines.push({text: FALLBACK_NOTE[note.reason], retry: true})
  } else if (lens.kind === 'gap-only' && note) {
    lines.push({text: GAP_ONLY_NOTE[note.reason], retry: failed(note.reason)})
  } else if (lens.kind === 'unverified' && note) {
    lines.push({text: UNVERIFIED_NOTE[note.reason], retry: failed(note.reason)})
  } else if (lens.kind === 'snapshot') {
    if (note && failed(note.reason)) {
      lines.push({text: KEPT_NOTE[note.reason], retry: true})
    }
    /*
     * `limited` shows nothing (skydeval, 2026-10-26): the posts prism could
     * not check stay held back, but a notice the reader can do nothing
     * about, on nearly every thread, is only noise.
     */
    if (lens.bridging === 'off') {
      lines.push({text: BRIDGING_OFF, retry: true})
    }
  }
  return lines
}

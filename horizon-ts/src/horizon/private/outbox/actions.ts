/*
 * 8.4's table as data (2K design): what an outbox entry shows and which of
 * its buttons it offers. A plain module, so the table is tested without the
 * design system.
 */

import {type OutboxView} from '#/horizon/private/outbox'
import {type WriteRoutes} from '#/horizon/routing/write-route'
import {
  presentIsPrefix,
  recordHasMedia,
  recordHasMediaFlags,
  recordUris,
} from './record'
import {
  elsewhereText,
  isParentFailure,
  mediaDroppedText,
  notPostedLabel,
  outboxFailureText,
  partlyPostedLabel,
  undecidedText,
} from './texts'

/**
 * What an entry shows and offers.
 */
export type OutboxEntryActions = {
  /** The row's state: Not posted, Partly posted, Checking..., or elsewhere. */
  label: string
  /** The 4.9 text, when there is one. */
  detail?: string
  /** "Images or video need adding again." */
  note?: string
  /** Retry, or Finish posting on a Partly posted entry. */
  retry?: {finish: boolean; disabled: boolean}
  edit: boolean
  discard: boolean
  deletePosted: boolean
  checkNow: boolean
  remove: boolean
}

/**
 * 8.4's table for one entry. `inUnsent` adds Remove from this device, which
 * the post itself never offers (SQ-19).
 */
export function outboxEntryActions(
  view: OutboxView,
  routes: WriteRoutes,
  {inUnsent}: {inUnsent: boolean},
): OutboxEntryActions {
  const none = {
    edit: false,
    discard: false,
    deletePosted: false,
    checkNow: false,
    remove: false,
  }
  const {record} = view
  if (view.runningElsewhere) return {label: elsewhereText(), ...none}
  const note =
    recordHasMedia(record) && !view.holdsCapture
      ? mediaDroppedText(recordHasMediaFlags(record))
      : undefined
  if (record.state !== 'failed') {
    return {
      label: undecidedText(),
      note,
      ...none,
      checkNow: true,
      discard: true,
      remove: inUnsent,
    }
  }
  const failure = record.failure
  const present = record.present ?? []
  const routeOk = routes.postingRoute === 'encode'
  if (failure === 'delete-discard') {
    return {
      label: outboxFailureText(failure),
      note,
      ...none,
      discard: true,
      remove: inUnsent,
    }
  }
  if (present.length > 0) {
    const uris = recordUris(record)
    const absent = uris
      .map((_uri, index) => index)
      .filter(index => !present.includes(uris[index]))
    const finishable =
      presentIsPrefix(record) &&
      failure !== 'video-blob' &&
      failure !== 'changed' &&
      (view.holdsCapture || !recordHasMedia(record, absent))
    return {
      label: partlyPostedLabel(),
      detail: failure ? outboxFailureText(failure, {partly: true}) : undefined,
      note,
      ...none,
      retry: finishable ? {finish: true, disabled: !routeOk} : undefined,
      deletePosted: true,
      remove: inUnsent,
    }
  }
  const retryable =
    !isParentFailure(failure) &&
    failure !== 'video-blob' &&
    (view.holdsCapture || !recordHasMedia(record))
  return {
    label: notPostedLabel(),
    detail: failure ? outboxFailureText(failure) : undefined,
    note,
    ...none,
    retry: retryable ? {finish: false, disabled: !routeOk} : undefined,
    edit: true,
    discard: true,
    remove: inUnsent,
  }
}

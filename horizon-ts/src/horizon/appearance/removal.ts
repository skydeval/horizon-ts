/*
 * Removal and rejoining (appearance storage choice design 8.2 to 8.5).
 *
 * The removal flow runs when the member table stops applying to a copy last
 * resolved as a member (`rev` not null): on a removal answer in this run
 * (the probe's `notEligible`, a private call's `NotEnrolled`), and also, with
 * no note, when an answered membership no longer lists `private.appearance`
 * (until prism lists it, members save as non-members do). It is the
 * non-member derivation with a defined start: nothing is written to prism,
 * the device keeps its copy and `pending`, a record step still due is
 * settled first, and a user's choice not yet landed is then applied as a
 * non-member's.
 *
 * Rejoining is the member table (`resolve.ts`): a record migrates, a copy on
 * `device` moves up unless `memberDevice` says the account chose `device`,
 * and anything else becomes `private` with nothing put until the first edit.
 */

import {type AppearanceQueueContext} from '#/horizon/appearance/context'
import {showRemovalNote} from '#/horizon/appearance/notices'
import {
  isTransientPdsError,
  mirrorValue,
  putAppearanceRecord,
} from '#/horizon/appearance/repo'
import {
  foldPending,
  nonMemberTable,
  withoutPendingStore,
} from '#/horizon/appearance/resolve'

/**
 * Run the removal flow (8.3). `removed`: a removal answer, which may show
 * the note (8.4). Resolves to whether it finished; if not (a read
 * unanswered), it runs again on the next trigger.
 */
export async function runRemovalFlow(
  ctx: AppearanceQueueContext,
  removed: boolean,
): Promise<boolean> {
  const start = ctx.getCopy()
  if (!start || start.rev === null) return true
  const lastStore = start.store
  const userStore =
    start.pending && !start.pending.auto ? start.pending.store : undefined

  // 1. Stop: prism writes stop, the copy and `pending` stay.
  ctx.update(c => ({...c, storeKnown: false}))

  // 2. A record step still due becomes a non-member one.
  if (start.recordDue) {
    const read = await ctx.readRecord()
    if (!read || !ctx.stillCurrent()) return false
    if (lastStore !== 'public') {
      // A due delete: the value is in the device copy.
      if (read.kind === 'record') {
        ctx.update(c => ({...c, cleanup: {cid: read.cid}}))
      }
    } else if (read.kind === 'record' && start.raw && !start.blocked) {
      // A due mirror updates an existing record and creates none.
      try {
        await putAppearanceRecord(
          ctx.client,
          ctx.did,
          mirrorValue(start.raw),
          read.cid,
        )
      } catch (error) {
        if (isTransientPdsError(error)) return false
        // The record changed or was refused: derive from what is there.
      }
    }
    ctx.update(c => ({...c, recordDue: false}))
  }

  // 3. Derive, waiting for the read.
  const record = await ctx.readRecord()
  if (!record || !ctx.stillCurrent()) return false
  let note = false
  ctx.update(c => {
    let next = nonMemberTable({...c, rev: null}, record).copy
    if (next.store === 'device') next = foldPending(next)
    // 4. A choice not yet landed: the user's applies as a non-member's.
    const pending = next.pending
    if (pending?.store) {
      if (pending.auto) {
        // Never the user's choice; the account never went private (AS7-N3).
        next = {...next, pending: withoutPendingStore(pending)}
      } else if (pending.store === 'private') {
        next = {...next, pending: {...pending, store: 'device'}}
      }
    }
    const ends = next.pending?.store ?? next.store
    // 5. The note (8.4).
    note =
      removed &&
      !c.removalNoted &&
      ends === 'device' &&
      (lastStore === 'private' || userStore === 'private')
    return {
      ...next,
      rev: null,
      noteDue: false,
      removalNoted: note ? true : next.removalNoted,
      removalLine: note ? true : next.removalLine,
    }
  })
  ctx.setRecordRead(record)
  if (note) showRemovalNote()
  return true
}

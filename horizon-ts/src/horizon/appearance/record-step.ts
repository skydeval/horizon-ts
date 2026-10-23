/*
 * The record step (appearance storage choice design 5.3): for a member, the
 * public record follows prism's last answer. With `public`, the row's value
 * is put exactly as prism answered it (never `pending`); otherwise the record
 * is deleted. Neither request is swapped (the field is left out): for a
 * member the record holds nothing that isn't in prism. After each request's
 * response, prism is read again; the step ends when that answer agrees with
 * what the request did, and otherwise goes round again.
 *
 * `recordDue` is durable, so a restart resumes the step. It runs in the
 * account's queue, after the member flush.
 */

import {logger} from '#/logger'
import {type AppearanceQueueContext} from '#/horizon/appearance/context'
import {
  showDeleteWarning,
  showMigrationNote,
} from '#/horizon/appearance/notices'
import {
  deleteAppearanceRecord,
  isTransientPdsError,
  mirrorValue,
  putAppearanceRecord,
} from '#/horizon/appearance/repo'

/**
 * Rounds per run. Once prism stops changing, a device's loop ends within two
 * requests (5.3); the cap only stops a prism that keeps changing from
 * holding the queue.
 */
export const MAX_RECORD_STEP_ROUNDS = 4

/** Run the record step while `recordDue` is set. */
export async function runRecordStep(ctx: AppearanceQueueContext) {
  for (let round = 0; round < MAX_RECORD_STEP_ROUNDS; round++) {
    const copy = ctx.getCopy()
    if (!copy?.recordDue || !ctx.stillCurrent() || !ctx.stillMember()) return
    // Step 1, with the copy's store, `rev` and value as they are now.
    const write = copy.store === 'public'
    const sentRev = copy.rev
    if (write) {
      // A mirror refused for good waits for the next app start (6.5).
      if (copy.blocked) return
      if (!copy.raw || !copy.record) {
        // prism answered `public` with no value to mirror.
        ctx.update(c => ({...c, recordDue: false}))
        return
      }
      const raw = copy.raw
      const appearance = copy.record
      try {
        const cid = await putAppearanceRecord(
          ctx.client,
          ctx.did,
          mirrorValue(raw),
          undefined,
        )
        ctx.setRecordRead({kind: 'record', appearance, raw, cid})
      } catch (error) {
        if (isTransientPdsError(error)) return
        logger.warn('appearance: the PDS refused the public mirror', {
          safeMessage: error instanceof Error ? error.message : String(error),
        })
        ctx.update(c => ({...c, blocked: true}))
        ctx.showBlocked()
        return
      }
    } else {
      try {
        await deleteAppearanceRecord(ctx.client, ctx.did)
        ctx.setRecordRead({kind: 'none'})
      } catch (error) {
        if (isTransientPdsError(error)) return
        logger.warn('appearance: the PDS refused the record delete', {
          safeMessage: error instanceof Error ? error.message : String(error),
        })
        showDeleteWarning(ctx.retry)
        return
      }
    }
    if (!ctx.stillCurrent()) return
    // Step 2: read prism after the request's response.
    const answer = await ctx.readPrism()
    if (!answer) return
    const isPublic = answer.row && answer.store === 'public'
    // Step 3.
    const agrees = write
      ? isPublic && answer.row && answer.rev === sentRev
      : !isPublic
    let note = false
    ctx.update(c => {
      /*
       * The migration note (section 6, step 4): when the delete is
       * confirmed and the read says the store isn't `public`; dropped if a
       * read says `public` first.
       */
      note = agrees && !write && c.noteDue
      return {
        ...c,
        recordDue: agrees ? false : c.recordDue,
        noteDue: isPublic || note ? false : c.noteDue,
        noted: note ? true : c.noted,
      }
    })
    if (note) showMigrationNote()
    if (agrees) return
  }
}

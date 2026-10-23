/*
 * The migration of an existing member's public appearance to private
 * (appearance storage choice design, section 6). Step 1 is the member
 * table's `auto` put (`resolve.ts`), an ordinary member flush; step 3 is the
 * record step (`record-step.ts`); step 4's note is shown there. This module
 * holds step 2, the verify (AS7-L3).
 */

import {type PrismAppearanceAnswer} from '#/horizon/appearance/prism'
import {
  type BuiltAppearanceRecord,
  parseAppearanceRecord,
} from '#/horizon/appearance/record'

/**
 * Whether the winner's answer holds what it sent: `store` is `private`, and
 * its value parses to the same appearance as the value sent. A mismatch is a
 * prism bug; the device then skips its own record step this run and shows no
 * note (the next member table on any device deletes the record).
 */
export function verifyMigration(
  sent: BuiltAppearanceRecord,
  answer: PrismAppearanceAnswer,
): boolean {
  if (!answer.row || answer.store !== 'private' || !answer.value) return false
  const expected = parseAppearanceRecord(sent)
  if (!expected) return false
  return (
    JSON.stringify(expected.appearance) ===
    JSON.stringify(answer.value.appearance)
  )
}

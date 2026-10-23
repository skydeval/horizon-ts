/*
 * The toasts of "Save my appearance" (appearance storage choice design 5.3,
 * 6, 7.1 and 8.4). The migration and removal notes also leave a line under
 * the setting until dismissed (`noted`, `removalLine`); the texts are shared
 * with it here. The too-large note is only a line (`tooLargeLine`) when the
 * migration hits prism's cap, and a toast when a user's choice does.
 */

import {t} from '@lingui/core/macro'
import {Trans} from '@lingui/react/macro'

import * as Toast from '#/components/Toast'
import {PRODUCT_NAME} from '#/horizon/branding'

/** The migration note (section 6). */
export function migrationNoteText() {
  return t`Your appearance is now private. ${PRODUCT_NAME} keeps your backdrop and theme settings for you and syncs them across your devices. They’re no longer in your public account. You can change this in Appearance, under “Save my appearance”.`
}

/** The note to a removed member (8.4). */
export function removalNoteText() {
  return t`Your ${PRODUCT_NAME} membership has ended, so your appearance is now saved on this device only. You can change this in Appearance, under “Save my appearance”.`
}

/**
 * The note to a removed member whose device copied prism's retained
 * appearance (removed members design, section 8).
 */
export function takenNoteText() {
  return t`Your ${PRODUCT_NAME} membership has ended, so your appearance is now saved on this device only. ${PRODUCT_NAME} moved it here from its servers and deletes its own copy within 7 days. You can change this in Appearance, under “Save my appearance”.`
}

export function showTakenNote() {
  Toast.show(takenNoteText(), {type: 'info'})
}

/** prism refused the appearance for its size (over 16 KiB). */
export function tooLargeNoteText() {
  return t`Your appearance is too large to save privately, so it stays public. You can choose “This device only” instead.`
}

/** A user's move to "Private, synced" refused for its size: the old choice stays. */
export function showTooLarge() {
  Toast.show(tooLargeNoteText(), {type: 'warning'})
}

export function showMigrationNote() {
  Toast.show(migrationNoteText(), {type: 'info'})
}

export function showRemovalNote() {
  Toast.show(removalNoteText(), {type: 'info'})
}

/** prism refused a choice change for good (7.1); the radio reverts. */
export function showChoiceRefused() {
  Toast.show(t`Couldn’t change where your appearance is saved.`, {
    type: 'warning',
  })
}

/** A record write the PDS refused for good (6.5, 5.3). */
export function showRecordBlocked() {
  Toast.show(
    t`Your appearance could not be saved to your account. It is saved on this device.`,
    {type: 'warning'},
  )
}

/** A member's record delete the PDS refused for good (5.3). */
export function showDeleteWarning(retry: () => void) {
  Toast.show(
    <Toast.Outer>
      <Toast.Icon />
      <Toast.Text>
        <Trans>
          {PRODUCT_NAME} couldn’t remove your appearance from your public account.
          It’s saved privately.
        </Trans>
      </Toast.Text>
      <Toast.Action label={t`Try again`} onPress={retry}>
        <Trans>Try again</Trans>
      </Toast.Action>
    </Toast.Outer>,
    {type: 'warning'},
  )
}

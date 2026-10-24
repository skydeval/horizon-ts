/*
 * How the "Posting as" logic tells the user about a refused choice, without
 * importing a UI module: the composer's control registers the toast when it
 * loads (`toasts.tsx`); until then a message is only logged.
 */

import {logger} from '#/logger'

type Notifier = (message: string) => void

let notifier: Notifier = message =>
  logger.info('posting as: notice with no toast', {message})

/** Set what shows a notice. Returns the previous notifier. */
export function setPostingNotifier(next: Notifier): Notifier {
  const previous = notifier
  notifier = next
  return previous
}

/** Show a notice about a refused choice. */
export function notifyPosting(message: string) {
  notifier(message)
}

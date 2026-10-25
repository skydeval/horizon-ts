/*
 * The sign-out seam's way to abandon registrations (system accounts design
 * 6.5 step 1) without importing the registration module itself: the
 * registry (`register.ts`) listens here once it is loaded. With no
 * registration module loaded there is no registration to abandon.
 */

/** The account a registration was started for. */
export type Abandonable = {addingFor: string}

type Listener = (which: (registration: Abandonable) => boolean) => void

const listeners = new Set<Listener>()

/** The registry listens here. Returns the unsubscribe function. */
export function onAbandonRegistrations(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Abandon every registration `which` picks. */
export function abandonRegistrations(
  which: (registration: Abandonable) => boolean,
) {
  listeners.forEach(listener => listener(which))
}

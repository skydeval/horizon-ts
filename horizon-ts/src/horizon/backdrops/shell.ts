/*
 * The web shell root's hook (Phase 3 design, 8.1, BD-1).
 */

import {useActiveBackdrop} from '#/horizon/backdrops/active'

/**
 * Whether the shell draws the backdrop: one is active and the account is
 * neither taken down nor deactivated (those screens render outside the
 * routes and paint no background of their own).
 */
export function useShellBackdrop(status: string | undefined): {
  active: boolean
} {
  const def = useActiveBackdrop()
  return {
    active: def !== null && status !== 'takendown' && status !== 'deactivated',
  }
}

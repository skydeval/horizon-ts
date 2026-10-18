import {useIsMember} from '#/horizon/private/membership'
import {PRIVATE_READING} from '#/horizon/switches'

/**
 * Whether profiles show the Private tab (6.4): to a signed-in member, on
 * every profile, since whether the owner is a member is not knowable.
 */
export function useShowPrivateTab(): boolean {
  const isMember = useIsMember()
  return PRIVATE_READING && isMember
}

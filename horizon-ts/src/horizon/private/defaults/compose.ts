/*
 * The private posting defaults as the composer reads them. Only an account
 * offered Private gets them (a member confirmed by prism in this run, on a
 * posting route that can write it: `VisibilityControl.tsx`); for anyone
 * else, and while the switches are off, there are none and the composer
 * starts Public with Everyone.
 */

import {usePostingDefaultsQuery} from '#/horizon/private/defaults/query'
import {type PrivateDefaults} from '#/horizon/private/defaults/record'
import {useCanPostPrivately} from '#/horizon/private/membership'
import {PRIVATE_POSTING, PRIVATE_POSTING_DEFAULTS} from '#/horizon/switches'

/**
 * Whether the private posting defaults apply at all (the switches).
 */
export function postingDefaultsOn(): boolean {
  return PRIVATE_POSTING && PRIVATE_POSTING_DEFAULTS
}

/**
 * The defaults a new compose starts from, or `undefined` when none apply.
 */
export function usePrivateComposeDefaults(): PrivateDefaults | undefined {
  const {offered} = useCanPostPrivately()
  const on = postingDefaultsOn() && offered
  const {data} = usePostingDefaultsQuery({enabled: on})
  return on ? data : undefined
}

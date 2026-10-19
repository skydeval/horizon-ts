/*
 * Shared strings of the Backdrops group (Phase 3 design, 10.9).
 */

import {useLingui} from '@lingui/react/macro'

import {type Channel} from '#/horizon/appearance/settings/editor'

/** A colour channel's letter and its name, for labels. */
export function useChannelLabels(channel: Channel): {
  letter: string
  name: string
} {
  const {t: l} = useLingui()
  switch (channel) {
    case 'r':
      return {
        letter: l({message: 'R', context: 'red colour channel'}),
        name: l({message: 'red', context: 'colour channel'}),
      }
    case 'g':
      return {
        letter: l({message: 'G', context: 'green colour channel'}),
        name: l({message: 'green', context: 'colour channel'}),
      }
    case 'b':
      return {
        letter: l({message: 'B', context: 'blue colour channel'}),
        name: l({message: 'blue', context: 'colour channel'}),
      }
  }
}

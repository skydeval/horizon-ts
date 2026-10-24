import {useMemo} from 'react'
import {useLingui} from '@lingui/react/macro'

// HORIZON: the CW self-label reads "Content warning"
import {horizonGlobalLabelStrings} from '#/horizon/media-spoilers/label-strings'

export type GlobalLabelStrings = Record<
  string,
  {
    name: string
    description: string
  }
>

export function useGlobalLabelStrings(): GlobalLabelStrings {
  // HORIZON: the CW self-label reads "Content warning" (its strings take i18n._)
  const {t: l, i18n} = useLingui()
  return useMemo(
    () => ({
      '!hide': {
        name: l`Content Blocked`,
        description: l`This content has been hidden by the moderators.`,
      },
      '!warn': {
        name: l`Content Warning`,
        description: l`This content has received a general warning from moderators.`,
      },
      '!no-unauthenticated': {
        name: l`Sign-in Required`,
        description: l`This user has requested that their content only be shown to signed-in users.`,
      },
      porn: {
        name: l`Adult Content`,
        description: l`Explicit sexual images.`,
      },
      sexual: {
        name: l`Sexually Suggestive`,
        description: l`Does not include nudity.`,
      },
      nudity: {
        name: l`Non-sexual Nudity`,
        description: l`E.g. artistic nudes.`,
      },
      'graphic-media': {
        name: l`Graphic Media`,
        description: l`Explicit or potentially disturbing media.`,
      },
      gore: {
        name: l`Graphic Media`,
        description: l`Explicit or potentially disturbing media.`,
      },
      // HORIZON: the CW self-label reads "Content warning"
      ...horizonGlobalLabelStrings(descriptor => i18n._(descriptor)),
    }),
    // HORIZON: the CW self-label reads "Content warning" (its strings take i18n._)
    [l, i18n],
  )
}

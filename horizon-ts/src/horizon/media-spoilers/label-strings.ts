/*
 * The CW self-label's name and description in the labels UI (2J follow-up):
 * the "Labels applied to this post" dialog shows "Content warning" in place
 * of the raw `app.nearhorizon.cw`. No labeler defines the value, so the
 * stock lookup falls back to the identifier; these strings sit with the
 * stock global ones (hook in `useGlobalLabelStrings`) and are used only at
 * that fallback (hook in `getLabelStrings`), so a labeler's own definition
 * of the value would still win.
 */

import {type MessageDescriptor} from '@lingui/core'
import {msg} from '@lingui/core/macro'

import {CW_SELF_LABEL} from './nsid'
import {contentWarningsOn} from './switches-read'

type LabelStrings = {name: string; description: string}

/**
 * Entries for the stock global label strings, translated with the stock
 * `_`: the CW self-label's, with content warnings on; none otherwise.
 */
export function horizonGlobalLabelStrings(
  _: (descriptor: MessageDescriptor) => string,
): Record<string, LabelStrings> {
  if (!contentWarningsOn()) return {}
  return {
    [CW_SELF_LABEL]: {
      name: _(
        msg({
          message: 'Content warning',
          comment:
            'Name of the self-label on a post its author put behind a content warning, in the list of labels on a post',
        }),
      ),
      description: _(
        msg({
          message: 'The author put this post behind a content warning.',
          comment:
            'Description of the self-label on a post its author put behind a content warning, in the list of labels on a post',
        }),
      ),
    },
  }
}

/**
 * The strings for a label definition nothing else names: the CW
 * self-label's, from the global strings, with content warnings on.
 * `undefined` for any other value, so it falls back as stock.
 */
export function horizonLabelStrings(
  locale: string,
  globalLabelStrings: Record<string, LabelStrings>,
  def: {identifier: string},
): {lang: string; name: string; description: string} | undefined {
  if (!contentWarningsOn() || def.identifier !== CW_SELF_LABEL) {
    return undefined
  }
  const strings = globalLabelStrings[CW_SELF_LABEL]
  if (!strings) return undefined
  return {lang: locale, name: strings.name, description: strings.description}
}

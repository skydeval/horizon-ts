/*
 * The composer's spoiler button (spoilers design, 7.1), web only: it asks the
 * active post's editor to wrap the selection in `||` markers. It shows a
 * hover hint (change list 2).
 */

import {useLingui} from '@lingui/react/macro'

import {textInputWebEmitter} from '#/view/com/composer/text-input/textInputWebEmitter'
import {atoms as a} from '#/alf'
import {Button} from '#/components/Button'
import {EyeSlash_Stroke2_Corner0_Rounded as EyeSlashIcon} from '#/components/icons/EyeSlash'
import {IS_WEB} from '#/env'
import {ToolbarHint} from '#/horizon/composer-hints/ToolbarHint'
import {SPOILER_TAGS} from '#/horizon/switches'
import {SPOILER_WRAP_EVENT} from './editor'

export function SpoilerButton() {
  const {t: l} = useLingui()
  if (!SPOILER_TAGS || !IS_WEB) return null
  return (
    <ToolbarHint
      label={l({
        message: 'Cover text as a spoiler',
        comment: 'Hover hint of the composer spoiler button',
      })}>
      <Button
        testID="spoilerBtn"
        onPress={() => {
          textInputWebEmitter.emit(SPOILER_WRAP_EVENT)
        }}
        label={l({
          message: 'Add spoiler',
          comment:
            'The composer button that wraps the selection in spoiler markers',
        })}
        accessibilityHint={l({
          message:
            'Covers the selected text, or adds spoiler markers at the cursor',
          comment: 'Screen reader hint of the composer spoiler button',
        })}
        style={a.p_sm}
        variant="ghost"
        shape="round"
        color="primary">
        <EyeSlashIcon size="lg" />
      </Button>
    </ToolbarHint>
  )
}

/*
 * The web editor's spoiler command (spoilers design, 7.2): the composer's
 * spoiler button asks the active post's editor to wrap its selection in
 * `||` markers, unwrap it, or insert an empty pair at the cursor.
 */

import {useEffect} from 'react'
import {TextSelection} from '@tiptap/pm/state'
import {type Editor} from '@tiptap/react'

import {textInputWebEmitter} from '#/view/com/composer/text-input/textInputWebEmitter'
import {SPOILER_TAGS} from '#/horizon/switches'
import {SPOILER_WRAP_EVENT, spoilerEditAction} from './spoiler-action'

export {
  SPOILER_WRAP_EVENT,
  type SpoilerEditAction,
  spoilerEditAction,
} from './spoiler-action'

/**
 * Apply the button to the editor's selection, as one undo step.
 */
export function applySpoilerWrap(editor: Editor) {
  const {doc, selection} = editor.state
  const sel = TextSelection.between(
    doc.resolve(selection.from),
    doc.resolve(selection.to),
  )
  const {from, to, empty} = sel
  const action = spoilerEditAction({
    empty,
    before: doc.textBetween(Math.max(0, from - 2), from, '\n'),
    after: doc.textBetween(to, Math.min(doc.content.size, to + 2), '\n'),
    selected: doc.textBetween(from, to, '\n'),
  })
  const chain = editor.chain().focus()
  switch (action) {
    case 'insert':
      chain.insertContentAt(from, '||||').setTextSelection(from + 2)
      break
    case 'wrap':
      chain
        .insertContentAt(to, '||')
        .insertContentAt(from, '||')
        .setTextSelection({from: from + 2, to: to + 2})
      break
    case 'unwrap':
      chain
        .deleteRange({from: to, to: to + 2})
        .deleteRange({from: from - 2, to: from})
        .setTextSelection({from: from - 2, to: to - 2})
      break
    case 'unwrapInner':
      chain
        .deleteRange({from: to - 2, to})
        .deleteRange({from, to: from + 2})
        .setTextSelection({from, to: to - 4})
      break
  }
  chain.run()
}

/**
 * While this post's editor is active and the switch is on, the spoiler
 * button's event runs the command on it.
 */
export function useSpoilerWrapCommand(
  editor: Editor | null,
  isActive: boolean,
) {
  useEffect(() => {
    if (!SPOILER_TAGS || !isActive || !editor) return
    const onWrap = () => applySpoilerWrap(editor)
    textInputWebEmitter.addListener(SPOILER_WRAP_EVENT, onWrap)
    return () => {
      textInputWebEmitter.removeListener(SPOILER_WRAP_EVENT, onWrap)
    }
  }, [editor, isActive])
}

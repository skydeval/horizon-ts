/*
 * Which spoilers of one rendered post are revealed or open (spoilers design,
 * 6.6). The state belongs to each rendering of a post, and starts over when
 * its text changes.
 */

import {useState} from 'react'

export type SpoilerRevealState = {
  text: string
  /** Inline spoilers revealed. There is no re-hide. */
  revealed: readonly number[]
  /** Drawers open. */
  open: readonly number[]
}

export type SpoilerRevealAction =
  | {type: 'reveal'; id: number}
  | {type: 'toggle'; id: number}
  | {type: 'reset'; text: string}

export function initialRevealState(text: string): SpoilerRevealState {
  return {text, revealed: [], open: []}
}

export function revealReducer(
  state: SpoilerRevealState,
  action: SpoilerRevealAction,
): SpoilerRevealState {
  switch (action.type) {
    case 'reveal':
      if (state.revealed.includes(action.id)) return state
      return {...state, revealed: [...state.revealed, action.id]}
    case 'toggle':
      return {
        ...state,
        open: state.open.includes(action.id)
          ? state.open.filter(id => id !== action.id)
          : [...state.open, action.id],
      }
    case 'reset':
      if (state.text === action.text) return state
      return initialRevealState(action.text)
  }
}

export function useSpoilerReveal(text: string) {
  const [state, setState] = useState(() => initialRevealState(text))
  let current = state
  // A derived reset during render, as stock does (`Composer.tsx`).
  if (state.text !== text) {
    current = revealReducer(state, {type: 'reset', text})
    setState(current)
  }
  return {
    isRevealed: (id: number) => current.revealed.includes(id),
    isOpen: (id: number) => current.open.includes(id),
    reveal: (id: number) =>
      setState(s => revealReducer(s, {type: 'reveal', id})),
    toggle: (id: number) =>
      setState(s => revealReducer(s, {type: 'toggle', id})),
  }
}

import {describe, expect, it} from '@jest/globals'

import {spoilerEditAction} from '../editor'
import {initialRevealState, revealReducer} from '../state'

describe('revealReducer (T6)', () => {
  it('reveals one id at a time, and only once', () => {
    let state = initialRevealState('a ||b|| ||c||')
    state = revealReducer(state, {type: 'reveal', id: 1})
    expect(state.revealed).toEqual([1])
    const same = revealReducer(state, {type: 'reveal', id: 1})
    expect(same).toBe(state)
    state = revealReducer(state, {type: 'reveal', id: 0})
    expect(state.revealed).toEqual([1, 0])
  })

  it('toggles drawers open and closed', () => {
    let state = initialRevealState('x')
    state = revealReducer(state, {type: 'toggle', id: 0})
    state = revealReducer(state, {type: 'toggle', id: 2})
    expect(state.open).toEqual([0, 2])
    state = revealReducer(state, {type: 'toggle', id: 0})
    expect(state.open).toEqual([2])
  })

  it('starts over when the text changes', () => {
    let state = initialRevealState('one')
    state = revealReducer(state, {type: 'reveal', id: 0})
    state = revealReducer(state, {type: 'toggle', id: 1})
    expect(revealReducer(state, {type: 'reset', text: 'one'})).toBe(state)
    expect(revealReducer(state, {type: 'reset', text: 'two'})).toEqual({
      text: 'two',
      revealed: [],
      open: [],
    })
  })
})

describe('spoilerEditAction (T7)', () => {
  const at = (
    selected: string,
    before = '',
    after = '',
  ): Parameters<typeof spoilerEditAction>[0] => ({
    empty: selected.length === 0,
    before,
    after,
    selected,
  })

  it('inserts an empty pair at a cursor', () => {
    expect(spoilerEditAction(at(''))).toBe('insert')
    expect(spoilerEditAction(at('', '||', '||'))).toBe('insert')
  })

  it('wraps a selection', () => {
    expect(spoilerEditAction(at('secret', 'a ', ' b'))).toBe('wrap')
  })

  it('unwraps a selection between markers', () => {
    expect(spoilerEditAction(at('secret', '||', '||'))).toBe('unwrap')
  })

  it('unwraps a selection that includes its markers', () => {
    expect(spoilerEditAction(at('||b||'))).toBe('unwrapInner')
  })

  it('wraps a selected empty pair rather than unwrapping it', () => {
    expect(spoilerEditAction(at('||||'))).toBe('wrap')
  })

  it('wraps when only one side is a marker', () => {
    expect(spoilerEditAction(at('secret', '||', ' b'))).toBe('wrap')
    expect(spoilerEditAction(at('secret', 'a ', '||'))).toBe('wrap')
  })
})

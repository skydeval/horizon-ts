import {describe, expect, it, jest} from '@jest/globals'

import {
  editorConfig,
  initEditor,
  isDraftValid,
  isEditorValid,
  onHexBlur,
  onHexChange,
  onSlider,
  sameConfig,
} from '#/horizon/appearance/settings/editor'
import {
  clearKeyDownCapture,
  type KeyEventLike,
  presetKeyDownCapture,
  rangeKeyDown,
  swatchKeyDown,
} from '#/horizon/appearance/settings/keys'

function key(k: string, extra: Partial<KeyEventLike> = {}) {
  return {
    key: k,
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
    ...extra,
  }
}

describe('the editor (T13)', () => {
  const start = initEditor({mode: 'twoTone', a: '#FFE2FF', b: '#CCFFFF'})

  it('a slider moves the hex with it', () => {
    const next = onSlider(start.a, 'g', 16)
    expect(next.rgb).toEqual({r: 255, g: 16, b: 255})
    expect(next.hexDraft).toBe('#FF10FF')
    expect(onSlider(start.a, 'r', 300).rgb.r).toBe(255)
  })

  it('a valid hex moves the RGB; an invalid one keeps it', () => {
    const typed = onHexChange(start.a, '102030')
    expect(typed.rgb).toEqual({r: 16, g: 32, b: 48})
    expect(typed.hexDraft).toBe('102030')
    expect(isDraftValid(typed)).toBe(true)
    const bad = onHexChange(typed, '#10203')
    expect(bad.rgb).toEqual({r: 16, g: 32, b: 48})
    expect(isDraftValid(bad)).toBe(false)
    expect(isEditorValid({...start, a: bad})).toBe(false)
    // Blur restores the hex of the committed RGB.
    expect(onHexBlur(bad).hexDraft).toBe('#102030')
  })

  it('Solid ignores an invalid second colour and keeps b', () => {
    const solid = {
      ...start,
      mode: 'solid' as const,
      b: onHexChange(start.b, 'zz'),
    }
    expect(isEditorValid(solid)).toBe(true)
    expect(editorConfig(solid)).toEqual({
      mode: 'solid',
      a: '#FFE2FF',
      b: '#CCFFFF',
    })
    expect(
      sameConfig(editorConfig(start), {
        mode: 'twoTone',
        a: '#FFE2FF',
        b: '#CCFFFF',
      }),
    ).toBe(true)
  })
})

describe('keys (T14)', () => {
  it('Space selects a swatch, without scrolling', () => {
    const select = jest.fn()
    const space = key(' ')
    swatchKeyDown(select)(space)
    expect(select).toHaveBeenCalledTimes(1)
    expect(space.preventDefault).toHaveBeenCalled()
    swatchKeyDown(select)(key('Enter'))
    expect(select).toHaveBeenCalledTimes(1)
  })

  it('preset chips: Enter and Space load, Shift+Enter saves, repeats do nothing', () => {
    const load = jest.fn()
    const save = jest.fn()
    const handler = presetKeyDownCapture({load, save})
    for (const e of [key('Enter'), key(' ')]) {
      handler(e)
      expect(e.preventDefault).toHaveBeenCalled()
      expect(e.stopPropagation).toHaveBeenCalled()
    }
    expect(load).toHaveBeenCalledTimes(2)
    const shift = key('Enter', {shiftKey: true})
    handler(shift)
    expect(save).toHaveBeenCalledTimes(1)
    expect(shift.stopPropagation).toHaveBeenCalled()
    const held = key('Enter', {repeat: true})
    handler(held)
    expect(held.stopPropagation).toHaveBeenCalled()
    expect(load).toHaveBeenCalledTimes(2)
    const tab = key('Tab')
    handler(tab)
    expect(tab.stopPropagation).not.toHaveBeenCalled()
  })

  it('clear chips: the first Enter arms, the second clears', () => {
    const arm = jest.fn()
    const clear = jest.fn()
    const first = key('Enter')
    clearKeyDownCapture({armed: false, arm, clear})(first)
    expect(arm).toHaveBeenCalledTimes(1)
    expect(first.stopPropagation).toHaveBeenCalled()
    clearKeyDownCapture({armed: true, arm, clear})(key('Enter'))
    expect(clear).toHaveBeenCalledTimes(1)
    const held = key('Enter', {repeat: true})
    clearKeyDownCapture({armed: true, arm, clear})(held)
    expect(held.stopPropagation).toHaveBeenCalled()
    const space = key(' ')
    clearKeyDownCapture({armed: true, arm, clear})(space)
    expect(space.stopPropagation).toHaveBeenCalled()
    expect(clear).toHaveBeenCalledTimes(1)
  })

  it('range inputs step 16 on Page keys', () => {
    const change = jest.fn()
    const up = key('PageUp')
    rangeKeyDown(250, change)(up)
    expect(change).toHaveBeenCalledWith(255)
    expect(up.preventDefault).toHaveBeenCalled()
    rangeKeyDown(20, change)(key('PageDown'))
    expect(change).toHaveBeenLastCalledWith(4)
    rangeKeyDown(20, change)(key('ArrowUp'))
    expect(change).toHaveBeenCalledTimes(2)
  })
})

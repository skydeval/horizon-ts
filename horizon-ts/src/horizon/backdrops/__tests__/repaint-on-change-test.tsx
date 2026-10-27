import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'
import {render} from '@testing-library/react-native'

import {
  repaintElement,
  RepaintOnChange,
} from '#/horizon/backdrops/RepaintOnChange.web'

/*
 * 2026-10-27: Firefox for Android left the bottom bar's Notifications tab
 * undrawn when its badge changed, until a scroll redrew the bar. The bar
 * now nudges its own opacity for two frames when a badge changes.
 */

type FakePiece = {
  style: {
    values: Record<string, string>
    getPropertyValue: (name: string) => string
    setProperty: (name: string, value: string) => void
  }
  writes: string[]
}

function fakePiece(): FakePiece {
  const writes: string[] = []
  const values: Record<string, string> = {}
  return {
    writes,
    style: {
      values,
      getPropertyValue: name => values[name] ?? '',
      setProperty: (name, value) => {
        values[name] = value
        writes.push(`${name}=${value}`)
      },
    },
  }
}

let frames: Array<() => void> = []

const g = globalThis as {
  requestAnimationFrame?: (cb: () => void) => number
  cancelAnimationFrame?: (handle: number) => void
}
const originalRaf = g.requestAnimationFrame
const originalCancel = g.cancelAnimationFrame

beforeEach(() => {
  frames = []
  g.requestAnimationFrame = (cb: () => void) => {
    frames.push(cb)
    return frames.length
  }
  g.cancelAnimationFrame = jest.fn()
})

afterEach(() => {
  g.requestAnimationFrame = originalRaf
  g.cancelAnimationFrame = originalCancel
})

function runFrames() {
  while (frames.length) frames.shift()!()
}

describe('repaintElement', () => {
  it('nudges opacity under 1, then restores it two frames later', () => {
    const piece = fakePiece()
    repaintElement(piece as unknown as HTMLElement)
    expect(piece.style.values.opacity).toBe('0.999')
    runFrames()
    expect(piece.style.values.opacity).toBe('')
    expect(piece.writes).toEqual(['opacity=0.999', 'opacity='])
  })
})

describe('RepaintOnChange', () => {
  function mount(piece: FakePiece, value: string) {
    return render(<RepaintOnChange value={value} />, {
      createNodeMock: () => ({parentElement: piece}),
    })
  }

  it('does nothing on the first render', () => {
    const piece = fakePiece()
    mount(piece, '')
    runFrames()
    expect(piece.writes).toEqual([])
  })

  it('redraws its piece when the value changes (a badge 1, then 2)', () => {
    const piece = fakePiece()
    const view = mount(piece, '')
    view.rerender(<RepaintOnChange value="1" />)
    expect(piece.style.values.opacity).toBe('0.999')
    runFrames()
    view.rerender(<RepaintOnChange value="2" />)
    expect(piece.style.values.opacity).toBe('0.999')
    runFrames()
    expect(piece.style.values.opacity).toBe('')
  })

  it('does not redraw on a re-render with the same value', () => {
    const piece = fakePiece()
    const view = mount(piece, '1')
    view.rerender(<RepaintOnChange value="1" />)
    expect(piece.writes).toEqual([])
  })
})

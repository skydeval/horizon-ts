/*
 * The web thread's first reply chunk (2026-10-26): a small first render,
 * raised to the stock chunk once the real answer has painted, once.
 */
import {useState} from 'react'
import {describe, expect, it} from '@jest/globals'
import {act, renderHook} from '@testing-library/react-native'

import {useGrowFirstChunk} from '#/horizon/thread-render/first-chunk'

async function frames() {
  await act(async () => {
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  })
}

function render(ready: boolean) {
  return renderHook(
    ({ready: on}: {ready: boolean}) => {
      const [count, setCount] = useState(15)
      useGrowFirstChunk({ready: on, count, chunk: 50, setCount})
      return {count, setCount}
    },
    {initialProps: {ready}},
  )
}

describe('useGrowFirstChunk', () => {
  it('waits for the real answer, then raises the count to the chunk', async () => {
    const hook = render(false)
    await frames()
    expect(hook.result.current.count).toBe(15)
    hook.rerender({ready: true})
    await frames()
    expect(hook.result.current.count).toBe(50)
  })

  it('grows once: a later reset stays where the screen put it', async () => {
    const hook = render(true)
    await frames()
    expect(hook.result.current.count).toBe(50)
    act(() => hook.result.current.setCount(() => 20))
    await frames()
    expect(hook.result.current.count).toBe(20)
  })
})

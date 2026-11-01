import {describe, expect, it, jest} from '@jest/globals'

import {createPendingSeen} from '#/horizon/notifications/mark-seen-in-view'

const at = (ms: number) => new Date(ms)

describe('createPendingSeen', () => {
  it('marks straight away when the screen is in view', () => {
    const send = jest.fn<(at: Date) => void>()
    const pending = createPendingSeen(send)
    pending.request(at(100), true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].getTime()).toBe(100)
  })

  it('holds a mark asked for out of view until the screen is in view', () => {
    const send = jest.fn<(at: Date) => void>()
    const pending = createPendingSeen(send)
    pending.request(at(100), false)
    pending.flush(false)
    expect(send).not.toHaveBeenCalled()
    pending.flush(true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].getTime()).toBe(100)
  })

  it('sends held marks once, up to the latest time', () => {
    const send = jest.fn<(at: Date) => void>()
    const pending = createPendingSeen(send)
    pending.request(at(300), false)
    pending.request(at(100), false)
    pending.flush(true)
    pending.flush(true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].getTime()).toBe(300)
  })

  it('never moves a held mark back when a later one is sent in view', () => {
    const send = jest.fn<(at: Date) => void>()
    const pending = createPendingSeen(send)
    pending.request(at(300), false)
    pending.request(at(200), true)
    expect(send.mock.calls[0][0].getTime()).toBe(300)
    pending.flush(true)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('sends nothing when nothing is held', () => {
    const send = jest.fn<(at: Date) => void>()
    createPendingSeen(send).flush(true)
    expect(send).not.toHaveBeenCalled()
  })
})

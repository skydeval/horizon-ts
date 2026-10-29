import {describe, expect, it, jest} from '@jest/globals'

import {HorizonDisposableStack} from '#/horizon/polyfills/explicit-resource-management'

/*
 * Horizon's stand-in for core-js's explicit resource management, which broke
 * Function.prototype.toString in the Android app.
 */
describe('explicit resource management polyfill', () => {
  it('defines the dispose symbols and a DisposableStack', () => {
    expect(typeof Symbol.dispose).toBe('symbol')
    expect(typeof Symbol.asyncDispose).toBe('symbol')
    expect(
      typeof (globalThis as {DisposableStack?: unknown}).DisposableStack,
    ).toBe('function')
  })

  it('leaves Function.prototype.toString alone', () => {
    function named() {}
    expect(Function.prototype.toString.call(named)).toContain('named')
    expect(String(named)).toContain('named')
  })

  it('disposes what it uses, last first, once', () => {
    const order: string[] = []
    const stack = new HorizonDisposableStack()
    const a = {[Symbol.dispose]: () => order.push('a')}
    const b = {[Symbol.dispose]: () => order.push('b')}
    expect(stack.use(a)).toBe(a)
    stack.use(b)
    stack.use(null)
    stack.dispose()
    stack.dispose()
    expect(order).toEqual(['b', 'a'])
    expect(stack.disposed).toBe(true)
  })

  it('refuses a value that is not disposable', () => {
    const stack = new HorizonDisposableStack()
    expect(() => stack.use({} as never)).toThrow(TypeError)
  })

  it('moves its clean-ups to a new stack, as the OAuth client does', () => {
    const dispose = jest.fn()
    const first = new HorizonDisposableStack()
    first.use({[Symbol.dispose]: dispose})
    const moved = first.move()
    expect(first.disposed).toBe(true)
    first.dispose()
    expect(dispose).not.toHaveBeenCalled()
    moved[Symbol.dispose]()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('runs every clean-up and rethrows the first failure', () => {
    const ran = jest.fn()
    const stack = new HorizonDisposableStack()
    stack.defer(ran)
    stack.defer(() => {
      throw new Error('first')
    })
    stack.defer(() => {
      throw new Error('second')
    })
    expect(() => stack.dispose()).toThrow('second')
    expect(ran).toHaveBeenCalledTimes(1)
  })
})

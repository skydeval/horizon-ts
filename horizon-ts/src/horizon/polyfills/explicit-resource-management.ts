/*
 * The small part of explicit resource management the Expo OAuth client needs
 * (native app sign-in): `Symbol.dispose`, `Symbol.asyncDispose` and
 * `DisposableStack`. Metro serves this in place of the client's
 * `core-js/proposals/explicit-resource-management` (metro.config.ts).
 *
 * Why not core-js: loading it replaced `Function.prototype.toString` with a
 * wrapper whose saved "original" was the wrapper itself, so the first
 * `toString` of a function after sign-in (Lingui's `Trans` in the drawer)
 * recursed until "Maximum call stack size exceeded (native stack depth)".
 *
 * Each piece is installed only where the engine lacks it.
 */

type Dispose = () => void

const symbols = Symbol as unknown as {
  dispose?: symbol
  asyncDispose?: symbol
}
if (!symbols.dispose) {
  Object.defineProperty(Symbol, 'dispose', {
    value: Symbol.for('Symbol.dispose'),
  })
}
if (!symbols.asyncDispose) {
  Object.defineProperty(Symbol, 'asyncDispose', {
    value: Symbol.for('Symbol.asyncDispose'),
  })
}

const DISPOSE = symbols.dispose as symbol

/**
 * A stack of clean-ups run last first, as the TC39 `DisposableStack`: the
 * methods the OAuth client uses (`use`, `move`, `dispose`), plus `defer` and
 * `adopt` for completeness.
 */
export class HorizonDisposableStack {
  #actions: Dispose[] = []
  #disposed = false

  get disposed() {
    return this.#disposed
  }

  #check() {
    if (this.#disposed) throw new ReferenceError('DisposableStack disposed')
  }

  use<T>(value: T): T {
    this.#check()
    if (value != null) {
      const dispose = (value as Record<symbol, unknown>)[DISPOSE]
      if (typeof dispose !== 'function') {
        throw new TypeError('Object not disposable')
      }
      this.#actions.push(() => dispose.call(value))
    }
    return value
  }

  adopt<T>(value: T, onDispose: (value: T) => void): T {
    this.#check()
    this.#actions.push(() => onDispose(value))
    return value
  }

  defer(onDispose: () => void) {
    this.#check()
    this.#actions.push(onDispose)
  }

  move(): HorizonDisposableStack {
    this.#check()
    const next = new HorizonDisposableStack()
    next.#actions = this.#actions
    this.#actions = []
    this.#disposed = true
    return next
  }

  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    const actions = this.#actions
    this.#actions = []
    let failed = false
    let error: unknown
    for (let i = actions.length - 1; i >= 0; i--) {
      try {
        actions[i]()
      } catch (e) {
        // A later failure keeps the first, as the spec's SuppressedError would
        if (!failed) error = e
        failed = true
      }
    }
    if (failed) throw error
  }

  [Symbol.dispose]() {
    this.dispose()
  }
}

const globals = globalThis as {DisposableStack?: unknown}
if (typeof globals.DisposableStack !== 'function') {
  globals.DisposableStack = HorizonDisposableStack
}

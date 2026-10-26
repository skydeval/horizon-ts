import {transformFileSync} from '@babel/core'
import {describe, expect, it} from '@jest/globals'

/*
 * The lens timing log must survive production builds, which run
 * `transform-remove-console` (babel.config.js): it exists to measure the
 * preview and production builds (Prism's report, 2026-10-26).
 */

describe('the lens timing log in a production build', () => {
  it('keeps its console line through transform-remove-console', () => {
    const out = transformFileSync(`${__dirname}/../timing.ts`, {
      babelrc: false,
      configFile: false,
      presets: ['@babel/preset-typescript'],
      plugins: ['transform-remove-console'],
    })
    expect(out?.code).toContain('[thread lens timing]')
  })
})

import {describe, expect, it, jest} from '@jest/globals'

import type * as SyncPlatformModule from '#/horizon/appearance/sync-platform'

/*
 * The app keeps its appearance on the device; web syncs it (skydeval,
 * 2026-10-29). The Jest setup mocks this module for the shared sync tests,
 * so these read the real files.
 */

type SyncPlatform = typeof SyncPlatformModule

describe('appearance sync per platform', () => {
  it('is off in the app', () => {
    const app = jest.requireActual<SyncPlatform>(
      '#/horizon/appearance/sync-platform',
    )
    expect(app.SYNCS_HERE).toBe(false)
    expect(app.appearanceSyncs()).toBe(false)
  })

  it('is on on web', () => {
    const web = jest.requireActual<SyncPlatform>(
      '#/horizon/appearance/sync-platform.web',
    )
    expect(web.SYNCS_HERE).toBe(true)
    expect(web.appearanceSyncs()).toBe(true)
  })
})

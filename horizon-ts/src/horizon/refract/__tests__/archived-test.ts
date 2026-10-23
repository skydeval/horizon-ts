import {describe, expect, it} from '@jest/globals'

import {showsArchivedBadge} from '#/horizon/refract/archived'
import {RF_STOCK_DID, rfPost} from '#/horizon/refract/fixtures'
import {type app} from '#/lexicons'

/*
 * The thread anchor's "Archived post" badge: a restored view's `indexedAt`
 * is prism's backfill time, so it gets no badge; stock views keep stock's
 * 24 h rule.
 */

type PostView = app.bsky.feed.defs.PostView

function view(
  restored: boolean,
  createdAt: string,
  indexedAt: string,
): PostView {
  const post = rfPost('p1', {
    did: restored ? undefined : RF_STOCK_DID,
    restored,
    createdAt,
  })
  return {...post, indexedAt} as unknown as PostView
}

describe('the Archived post badge', () => {
  it('is not shown on a restored view backfilled days later', () => {
    expect(
      showsArchivedBadge(
        view(true, '2026-10-13T10:00:00.000Z', '2026-10-22T10:00:00.000Z'),
      ),
    ).toBe(false)
  })

  it('is shown on a stock view created 24 h or more before it was indexed', () => {
    expect(
      showsArchivedBadge(
        view(false, '2026-10-13T10:00:00.000Z', '2026-10-22T10:00:00.000Z'),
      ),
    ).toBe(true)
  })

  it('is not shown on a stock view indexed when it was written', () => {
    expect(
      showsArchivedBadge(
        view(false, '2026-10-22T09:00:00.000Z', '2026-10-22T10:00:00.000Z'),
      ),
    ).toBe(false)
  })
})

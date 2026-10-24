/* oxlint-disable import/no-nodejs-modules -- reads the composer source as text, in jest only */
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {describe, expect, it} from '@jest/globals'

/*
 * Every publish path of the stock composer goes through `onPressPublish`,
 * which returns on `!canPost`, and `canPost` takes the compose's audience and
 * the posting account's hold as values, so an unpicked audience (P5R7-L1)
 * and a posting account still loading (Phase 5 8.2, PA-9) block the button,
 * the keyboard publish, the skip-empty confirm and the publish-on-upload
 * effect alike (P5R6-N1). The composer is too large to render in jest, so
 * its source is checked.
 */
const source = readFileSync(
  join(__dirname, '../../../view/com/composer/Composer.tsx'),
  'utf8',
)
const threadgateBtn = readFileSync(
  join(__dirname, '../../../view/com/composer/threadgate/ThreadgateBtn.tsx'),
  'utf8',
)
const draftQueries = readFileSync(
  join(__dirname, '../../../view/com/composer/drafts/state/queries.ts'),
  'utf8',
)

function body(start: string): string {
  const from = source.indexOf(start)
  expect(from).toBeGreaterThan(-1)
  return source.slice(from)
}

describe('the composer publish paths (P5R7-L1, P5R6-N1)', () => {
  it('canPost passes the audience and the posting account’s routes and hold, all from the session hook', () => {
    expect(source).toMatch(
      /const \{isPrivate, audience, postingRoute, postingAllows\} =\s*usePrivateComposeSession\(/,
    )
    expect(body('const canPost =')).toMatch(
      /^const canPost =\s*\/\/[^\n]*\n\s*privateComposeAllows\(thread, isPrivate, postingRoute, audience\) &&\n\s*postingAllows &&/,
    )
  })

  it('onPressPublish returns on !canPost before the one post call', () => {
    const publish = body('const onPressPublish = useCallback(')
    const guard = publish.indexOf('if (!canPost) {\n      return\n    }')
    const post = publish.indexOf('apilib.post(')
    expect(guard).toBeGreaterThan(-1)
    expect(post).toBeGreaterThan(guard)
    expect(source.split('apilib.post(')).toHaveLength(2)
  })

  it('every other path calls onPressPublish, and the button follows canPost', () => {
    const calls = source.match(/void onPressPublish\(\)/g) ?? []
    // The skip-empty confirm, the keyboard publish, publish-on-upload, the button.
    expect(calls).toHaveLength(4)
    expect(source).toContain('disabled={!canPost || isPublishQueued}')
  })
})

describe('the "Posting as" hooks (Phase 5 PA-1 to PA-12)', () => {
  it('PA-2: the posting account’s clients are taken, and its gates checked, before the one post call, inside its try', () => {
    const publish = body('const onPressPublish = useCallback(')
    const tryAt = publish.indexOf('try {')
    const begin = publish.indexOf('posting = beginPostingPublish(')
    const post = publish.indexOf('apilib.post(')
    expect(begin).toBeGreaterThan(tryAt)
    expect(post).toBeGreaterThan(begin)
    const call = publish.slice(post, publish.indexOf('.uris[0]', post))
    expect(call).toContain('...posting.clients')
    expect(call).not.toMatch(/\bpdsClient,|\bappviewClient: client/)
  })

  it('PA-1: the first post’s avatar is the control; PA-11: both video paths refuse first', () => {
    expect(source).toContain('<PostingAsControl isFirstPost={isFirstPost}>')
    for (const start of [
      'const selectVideo = useCallback(',
      'const restoreVideo = useCallback(',
    ]) {
      const fn = body(start)
      const refusal = fn.indexOf('postingVideoRefusal()')
      expect(refusal).toBeGreaterThan(-1)
      expect(fn.indexOf('processVideo(')).toBeGreaterThan(refusal)
    }
  })

  it('PA-10: the draft’s posting account is set before its gates and its visibility, and foreign lists are dropped in the record form', () => {
    const restore = body('const handleSelectDraft = useCallback(')
    const posting = restore.indexOf('applyDraftPostingAs(draftSummary.id)')
    const dispatch = restore.indexOf("type: 'restore_from_draft'")
    const visibility = restore.indexOf('applyDraftVisibility(draftSummary.id)')
    expect(posting).toBeGreaterThan(-1)
    expect(dispatch).toBeGreaterThan(posting)
    expect(visibility).toBeGreaterThan(dispatch)
    expect(restore).toMatch(
      /threadgateAllow: restoredThreadgateAllow\(\s*postingDid,\s*draftSummary\.draft\.threadgateAllow,/,
    )
  })

  it('PA-10: a draft save captures its posting account before its first await, and records it with the visibility', () => {
    const save = draftQueries.slice(draftQueries.indexOf('mutationFn: async'))
    const capture = save.indexOf('const postingAs = captureDraftPostingAs()')
    expect(capture).toBeGreaterThan(-1)
    // The first await in code, not in a comment.
    expect(save.search(/^\s*(const .* = )?await /m)).toBeGreaterThan(capture)
    expect(save).toContain('recordDraftPostingAs(draftId, postingAs)')
  })

  it('PA-9: Clear re-seeds from the posting account’s settings', () => {
    expect(body('const handleClearComposer = useCallback(')).toMatch(
      /initInteractionSettings: postingInteractionSettings\(/,
    )
  })

  it('PA-12: the stock pill is held while the reset applies; PA-12a: its dialog never saves the current account’s defaults for another', () => {
    expect(source).toMatch(
      /postingResetPending \? \(\s*\/\/[^\n]*\n\s*<HeldInteractionPill/,
    )
    expect(threadgateBtn).toContain(
      'const savesDefaults = useIsPostingAsCurrent()',
    )
    expect(threadgateBtn).toContain(
      'persist={savesDefaults ? persist : undefined}',
    )
    expect(threadgateBtn).toContain('if (persist && savesDefaults) {')
  })
})

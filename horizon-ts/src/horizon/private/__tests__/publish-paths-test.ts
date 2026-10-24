/* oxlint-disable import/no-nodejs-modules -- reads the composer source as text, in jest only */
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {describe, expect, it} from '@jest/globals'

/*
 * Every publish path of the stock composer goes through `onPressPublish`,
 * which returns on `!canPost`, and `canPost` takes the compose's audience, so
 * an unpicked audience (P5R7-L1) blocks the button, the keyboard publish, the
 * skip-empty confirm and the publish-on-upload effect alike (P5R6-N1). The
 * composer is too large to render in jest, so its source is checked.
 */
const source = readFileSync(
  join(__dirname, '../../../view/com/composer/Composer.tsx'),
  'utf8',
)

function body(start: string): string {
  const from = source.indexOf(start)
  expect(from).toBeGreaterThan(-1)
  return source.slice(from)
}

describe('the composer publish paths (P5R7-L1, P5R6-N1)', () => {
  it('canPost passes the audience to privateComposeAllows, from the session hook', () => {
    expect(source).toMatch(
      /const \{isPrivate, audience, postingRoute\} = usePrivateComposeSession\(/,
    )
    expect(body('const canPost =')).toMatch(
      /^const canPost =\s*\/\/[^\n]*\n\s*privateComposeAllows\(thread, isPrivate, postingRoute, audience\) &&/,
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

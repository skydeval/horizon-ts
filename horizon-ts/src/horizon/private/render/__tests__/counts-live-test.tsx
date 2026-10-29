import {Text} from 'react-native'
import {describe, expect, it} from '@jest/globals'
import {act, render} from '@testing-library/react-native'

import {usePrivateControls} from '#/horizon/private/render/controls'
import {setPrivatePostFacts} from '#/horizon/private/store'

/*
 * A private post's counts show once prism serves them, even when that is
 * after the post first rendered (a plain store read in render was cached by
 * the React Compiler, so the counts stayed blank until the post was opened).
 */

const URI = 'at://did:plc:jjjjjjjjjjjjjjjjjjjjjjjj/tools.kryphocron.feed.postPrivate/3lcountslive'

function Probe() {
  const {hideCounts} = usePrivateControls(URI)
  return <Text>{hideCounts ? 'hidden' : 'shown'}</Text>
}

describe('private post counts', () => {
  it('show when prism serves them after the first render', () => {
    const view = render(<Probe />)
    expect(view.getByText('hidden')).toBeTruthy()
    act(() => {
      setPrivatePostFacts(URI, {isPending: false, countsServed: true})
    })
    expect(view.getByText('shown')).toBeTruthy()
  })
})

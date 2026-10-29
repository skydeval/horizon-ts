import {Text} from 'react-native'
import {describe, expect, it} from '@jest/globals'
import {render} from '@testing-library/react-native'

import {
  BarHaloContext,
  useOutlineCopyColor,
} from '#/horizon/backdrops/bar-halo-context'
import {barOutline} from '#/horizon/backdrops/frame'
import {Outlined} from '#/horizon/backdrops/Outlined'

/*
 * The drawer's outline in the app: eight copies in the outline's colour
 * behind the text, a point out every way (skydeval, 2026-10-29).
 */

function Probe() {
  const copy = useOutlineCopyColor()
  return <Text>{copy ?? 'main'}</Text>
}

describe('Outlined', () => {
  it('draws eight copies in the outline colour behind the children', () => {
    const outline = barOutline('dark')
    const {getAllByText} = render(
      <BarHaloContext.Provider value={outline}>
        <Outlined>
          <Probe />
        </Outlined>
      </BarHaloContext.Provider>,
    )
    // The copies are hidden from screen readers, so the query must look
    expect(
      getAllByText(outline.halo, {includeHiddenElements: true}),
    ).toHaveLength(8)
    expect(getAllByText('main')).toHaveLength(1)
  })

  it('is the children only outside an outline scope', () => {
    const {getAllByText, queryByText} = render(
      <Outlined>
        <Probe />
      </Outlined>,
    )
    expect(getAllByText('main')).toHaveLength(1)
    expect(
      queryByText(barOutline('dark').halo, {includeHiddenElements: true}),
    ).toBeNull()
  })
})

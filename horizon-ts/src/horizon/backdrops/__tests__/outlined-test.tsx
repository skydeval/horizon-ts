import {Text as RNText} from 'react-native'
import {describe, expect, it} from '@jest/globals'
import {render} from '@testing-library/react-native'

import {Text} from '#/components/Typography'
import {
  BarHaloContext,
  OUTLINE_SHADOW_BLUR,
  useOutlineShadow,
} from '#/horizon/backdrops/bar-halo-context'
import {
  barOutline,
  OUTLINE_SHADOW_ALPHA,
  outlineColor,
} from '#/horizon/backdrops/frame'
import {Outlined} from '#/horizon/backdrops/Outlined'

/*
 * The drawer's text in the app: one soft shadow in the theme's tint, the
 * text's own colour kept, no copies (skydeval, 2026-10-29: copies read as
 * pills behind each word).
 */

function Probe() {
  const shadow = useOutlineShadow()
  return <RNText>{shadow ?? 'none'}</RNText>
}

describe('Outlined', () => {
  it('hands its text a soft shadow and draws no copies', () => {
    const shadow = outlineColor('light', OUTLINE_SHADOW_ALPHA)
    const view = render(
      <BarHaloContext.Provider value={barOutline('light')}>
        <Outlined>
          <Probe />
          <Text style={{color: 'blue'}}>Home</Text>
        </Outlined>
      </BarHaloContext.Provider>,
    )
    expect(view.getAllByText(shadow, {includeHiddenElements: true})).toHaveLength(
      1,
    )
    const home = view.getAllByText('Home', {includeHiddenElements: true})
    expect(home).toHaveLength(1)
    expect(home[0]).toHaveStyle({
      color: 'blue',
      textShadowColor: shadow,
      textShadowRadius: OUTLINE_SHADOW_BLUR,
    })
  })

  it('is the children only outside an outline scope', () => {
    const view = render(
      <Outlined>
        <Probe />
      </Outlined>,
    )
    expect(view.getByText('none')).toBeTruthy()
  })
})

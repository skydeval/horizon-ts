import {Text} from 'react-native'
import {describe, expect, it} from '@jest/globals'
import {render} from '@testing-library/react-native'

import {
  BarHaloContext,
  OUTLINE_SHADOW_BLUR,
  outlineShadowTextStyle,
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
  return <Text>{shadow ?? 'none'}</Text>
}

describe('Outlined', () => {
  it('hands its text one soft shadow and draws no copies', () => {
    const outline = barOutline('light')
    expect(outline.textShadow).toBe(
      outlineColor('light', OUTLINE_SHADOW_ALPHA),
    )
    const view = render(
      <BarHaloContext.Provider value={outline}>
        <Outlined>
          <Probe />
        </Outlined>
      </BarHaloContext.Provider>,
    )
    expect(
      view.getAllByText(outline.textShadow, {includeHiddenElements: true}),
    ).toHaveLength(1)
  })

  it('the shadow keeps the text colour', () => {
    const style = outlineShadowTextStyle('rgba(0, 0, 0, 0.9)')
    expect(style).toEqual({
      textShadowColor: 'rgba(0, 0, 0, 0.9)',
      textShadowOffset: {width: 0, height: 0},
      textShadowRadius: OUTLINE_SHADOW_BLUR,
    })
    expect('color' in style).toBe(false)
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

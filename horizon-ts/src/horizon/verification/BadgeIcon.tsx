/*
 * One verification badge, drawn by prism's rule (`badges.ts`): fill the
 * shape, stroke the outline inside it, centre the mark at 55%. An image
 * badge draws prism's PNG over the box. Decorative: the caller names it.
 */

import {useId} from 'react'
import Svg, {
  Defs,
  G,
  Image as SvgImage,
  LinearGradient,
  Path,
  Stop,
  Text as SvgText,
} from 'react-native-svg'

import {useTheme} from '#/alf'
import {
  BADGE_SHAPES,
  type BadgeDesign,
  gradientVector,
  MARK_CHECK,
  MARK_SCALE,
  markFontSize,
  outlineGeometry,
} from './badges'

export function BadgeIcon({
  light,
  dark,
  width,
}: {
  light: BadgeDesign
  dark: BadgeDesign
  width: number
}) {
  const t = useTheme()
  const design = t.scheme === 'dark' ? dark : light
  const gradientId = `badge-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`

  if (design.shape === 'image') {
    return (
      <Svg width={width} height={width} viewBox="0 0 24 24" accessible={false}>
        {design.image ? (
          <SvgImage
            href={design.image}
            x={0}
            y={0}
            width={24}
            height={24}
            preserveAspectRatio="xMidYMid meet"
          />
        ) : null}
      </Svg>
    )
  }

  const path = BADGE_SHAPES[design.shape]
  const fill =
    design.fill.kind === 'solid' ? design.fill.color : `url(#${gradientId})`
  const outline = design.outline
    ? {...outlineGeometry(design.outline.width), color: design.outline.color}
    : undefined
  const mark = design.mark
  const vector =
    design.fill.kind === 'gradient'
      ? gradientVector(design.fill.angle)
      : undefined

  return (
    <Svg width={width} height={width} viewBox="0 0 24 24" accessible={false}>
      {design.fill.kind === 'gradient' && vector ? (
        <Defs>
          <LinearGradient
            id={gradientId}
            gradientUnits="objectBoundingBox"
            x1={vector.x1}
            y1={vector.y1}
            x2={vector.x2}
            y2={vector.y2}>
            <Stop offset="0" stopColor={design.fill.from} />
            <Stop offset="1" stopColor={design.fill.to} />
          </LinearGradient>
        </Defs>
      ) : null}
      {outline ? (
        <G
          transform={`translate(12 12) scale(${outline.scale}) translate(-12 -12)`}>
          <Path
            d={path}
            fill={fill}
            stroke={outline.color}
            strokeWidth={outline.strokeWidth}
            strokeLinejoin="round"
          />
        </G>
      ) : (
        <Path d={path} fill={fill} />
      )}
      {mark ? (
        <G
          transform={`translate(12 12) scale(${MARK_SCALE}) translate(-12 -12)`}>
          {mark.kind === 'check' ? (
            <Path d={MARK_CHECK} fill={mark.color} />
          ) : (
            <SvgText
              x={12}
              y={12}
              fill={mark.color}
              fontSize={markFontSize(mark.value ?? '')}
              fontWeight="bold"
              textAnchor="middle"
              alignmentBaseline="central">
              {mark.value}
            </SvgText>
          )}
        </G>
      ) : null}
    </Svg>
  )
}

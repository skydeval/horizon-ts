import {type PathProps, type SvgProps} from 'react-native-svg'

// HORIZON: branding import
import {HorizonMark} from '#/horizon/branding/marks'

export function Logomark({
  fill,
  width,
  height: _height,
  ...rest
}: {fill?: PathProps['fill']} & SvgProps) {
  // @ts-expect-error it's fiiiiine
  const size = parseInt(width || 32)

  // HORIZON: branding: Horizon's mark in place of Bluesky's butterfly; full colour, or one colour when a fill is given
  return (
    <HorizonMark {...rest} size={size} fill={fill ? String(fill) : undefined} />
  )
}

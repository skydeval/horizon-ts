import {type PathProps, type SvgProps} from 'react-native-svg'

import {usePalette} from '#/lib/hooks/usePalette'
// HORIZON: branding import
import {HorizonWordmark} from '#/horizon/branding/marks'

export function Logotype({
  fill,
  width,
  height: _height,
  ...rest
}: {fill?: PathProps['fill']} & SvgProps) {
  const pal = usePalette('default')
  // @ts-expect-error it's fiiiiine
  const size = parseInt(width || 32)

  // HORIZON: branding: the "Horizon" wordmark in place of Bluesky's
  return (
    <HorizonWordmark
      {...rest}
      width={size}
      fill={String(fill || pal.text.color)}
    />
  )
}

import {type PathProps, type SvgProps} from 'react-native-svg'

import {useTheme} from '#/alf'
// HORIZON: branding import
import {HorizonLockup} from '#/horizon/branding/marks'

export function LogomarkWithType({
  fill,
  width,
  height: _height,
  ...rest
}: {fill?: PathProps['fill']} & SvgProps) {
  const t = useTheme()
  const size = parseInt(`${width || 32}`)

  // HORIZON: branding: Horizon's lockup (full-colour mark and wordmark) in place of Bluesky's
  return (
    <HorizonLockup
      {...rest}
      width={size}
      fill={String(fill || t.atoms.text.color)}
    />
  )
}

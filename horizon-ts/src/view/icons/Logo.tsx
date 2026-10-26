import {forwardRef} from 'react'
import {type TextProps} from 'react-native'
import {type PathProps, type SvgProps} from 'react-native-svg'

// HORIZON: the kawaii artwork is not covered by MIT and was removed, with its Image and useLogoVariant imports
import {flatten} from '#/alf'
// HORIZON: branding import
import {HorizonMark} from '#/horizon/branding/marks'

type Props = {
  allowVariants?: boolean
  fill?: PathProps['fill']
  style?: TextProps['style']
} & Omit<SvgProps, 'style'>

export const Logo = forwardRef(function LogoImpl(props: Props, _ref) {
  const {allowVariants: _allowVariants, fill, width, height: _height, ...rest} =
    props
  const styles = flatten(props.style)
  // @ts-expect-error it's fiiiiine
  const size = parseInt(width || 32, 10)

  // HORIZON: branding: Horizon's mark in place of Bluesky's butterfly; full colour, or one colour when a fill is given ('sky' keeps full colour)
  return (
    <HorizonMark
      {...rest}
      size={size}
      fill={fill && fill !== 'sky' ? String(fill) : undefined}
      style={styles}
    />
  )
})

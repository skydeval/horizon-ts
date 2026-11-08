/*
 * The composer's image layout drop-down, beside Labels: Gallery (the usual
 * grid) or Carousel. Carousel sends 2 to 4 images as a gallery embed, which
 * Horizon shows as a carousel; Bluesky's app shows it as a grid. With more
 * than 4 images every post is a carousel (a grid holds 4), so Gallery shows
 * greyed out with the reason.
 */

import {Keyboard} from 'react-native'
import {useLingui} from '@lingui/react/macro'

import {Button, ButtonIcon, ButtonText} from '#/components/Button'
import {TinyChevronBottom_Stroke2_Corner0_Rounded as TinyChevronIcon} from '#/components/icons/Chevron'
import {Image_Stroke2_Corner2_Rounded as ImageIcon} from '#/components/icons/Image'
import * as Menu from '#/components/Menu'

export function ImageLayoutBtn({
  carousel,
  galleryAvailable = true,
  onChange,
}: {
  carousel: boolean
  /** False with 5 or more images: a grid holds 4, so it's a carousel. */
  galleryAvailable?: boolean
  onChange: (carousel: boolean) => void
}) {
  const {t: l} = useLingui()
  const gallery = l({
    message: 'Gallery',
    comment: 'Image layout in a post: the usual grid of images',
  })
  const galleryItemLabel = galleryAvailable
    ? gallery
    : l({
        message: 'Gallery (up to 4 images)',
        comment:
          'Image layout option shown greyed out when 5 or more images are attached',
      })
  const carouselLabel = l({
    message: 'Carousel',
    comment: 'Image layout in a post: images you swipe through one at a time',
  })
  const current = carousel ? carouselLabel : gallery

  return (
    <Menu.Root>
      <Menu.Trigger label={l`Image layout (currently: ${current})`}>
        {({props}) => (
          <Button
            {...props}
            testID="imageLayoutBtn"
            label={props.accessibilityLabel}
            onPress={e => {
              Keyboard.dismiss()
              props.onPress?.(e)
            }}
            color="secondary"
            size="small">
            <ButtonIcon icon={ImageIcon} />
            <ButtonText numberOfLines={1} maxFontSizeMultiplier={2}>
              {current}
            </ButtonText>
            <ButtonIcon icon={TinyChevronIcon} size="2xs" />
          </Button>
        )}
      </Menu.Trigger>
      <Menu.Outer>
        <Menu.Group>
          <Menu.Item
            testID="imageLayoutGallery"
            label={galleryItemLabel}
            disabled={!galleryAvailable}
            onPress={() => onChange(false)}>
            <Menu.ItemText>{galleryItemLabel}</Menu.ItemText>
            <Menu.ItemRadio selected={!carousel} />
          </Menu.Item>
          <Menu.Item
            testID="imageLayoutCarousel"
            label={carouselLabel}
            onPress={() => onChange(true)}>
            <Menu.ItemText>{carouselLabel}</Menu.ItemText>
            <Menu.ItemRadio selected={carousel} />
          </Menu.Item>
        </Menu.Group>
      </Menu.Outer>
    </Menu.Root>
  )
}

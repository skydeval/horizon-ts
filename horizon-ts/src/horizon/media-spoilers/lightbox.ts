/*
 * The lightbox lists only the images that may be shown (2J design, 6.6,
 * MS-8), so paging cannot show a sibling that is still covered. A covered
 * image never opens it: the cover is the way in.
 */

type LightboxArgument = {
  images: unknown[]
  index: number
  onIndexChange?: (index: number) => void
}

/**
 * The lightbox argument without the images that are covered, given per
 * image whether it may be shown (`shown`). The index is mapped to the kept
 * images, and `onIndexChange` receives the original index again. Nothing
 * covered: the argument itself. The pressed image covered: `undefined`.
 * When `shown` does not match the images, every image counts as covered as
 * soon as one is (fail closed).
 */
export function withoutCoveredLightboxImages<T extends LightboxArgument>(
  shown: readonly boolean[] | undefined,
  lightbox: T,
): T | undefined {
  if (!shown || shown.every(Boolean)) return lightbox
  const matches = shown.length === lightbox.images.length
  const isShown = (i: number) => matches && shown[i]
  if (!isShown(lightbox.index)) return undefined
  const kept: number[] = []
  lightbox.images.forEach((_, i) => {
    if (isShown(i)) kept.push(i)
  })
  const onIndexChange = lightbox.onIndexChange
  return {
    ...lightbox,
    images: kept.map(i => lightbox.images[i]),
    index: kept.indexOf(lightbox.index),
    onIndexChange: onIndexChange
      ? (index: number) => {
          const original = kept[index]
          if (original !== undefined) onIndexChange(original)
        }
      : undefined,
  }
}

/**
 * Hook MS 23: the lightbox argument for the images of a media spoiler scope
 * (`undefined` outside one, or with the switch off).
 */
export function withoutCoveredImages<T extends LightboxArgument>(
  scope: {revealedFlags: () => boolean[]} | undefined,
  lightbox: T,
): T | undefined {
  return withoutCoveredLightboxImages(scope?.revealedFlags(), lightbox)
}

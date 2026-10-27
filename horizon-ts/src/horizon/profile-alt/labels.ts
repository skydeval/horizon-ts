import {t} from '@lingui/core/macro'

/**
 * An image control's label with the image's description after it, never in
 * place of it, so the action is still said first. `label` alone without a
 * description.
 */
export function labelWithAlt(label: string, alt: string | undefined): string {
  if (!alt) return label
  return t({
    message: `${label}. Image description: ${alt}`,
    comment:
      'Screen reader label of a profile avatar or banner, then the description its owner wrote for it',
  })
}

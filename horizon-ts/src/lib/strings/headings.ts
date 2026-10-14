// HORIZON: page titles name Horizon
import {PRODUCT_NAME} from '#/horizon/branding'

export function bskyTitle(page: string, unreadCountLabel?: string) {
  const unreadPrefix = unreadCountLabel ? `(${unreadCountLabel}) ` : ''
  // HORIZON: page titles name Horizon
  return `${unreadPrefix}${page} — ${PRODUCT_NAME}`
}

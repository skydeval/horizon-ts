/*
 * The signed-out welcome window in Horizon's look (skydeval, 2026-10-27):
 * the meadow photo (`welcome-meadow.jpg`, generated with Gemini for Horizon)
 * in place of Bluesky's clouds, the "Horizon" wordmark, Horizon's tagline,
 * and the brand's green for the actions. Everything sits in the photo's sky,
 * above the hills, so the window starts its column from the top rather than
 * centring it.
 */

import {PRODUCT_NAME} from '#/horizon/branding'
import {BRAND_COLORS, HorizonWordmark} from '#/horizon/branding/marks'

/** The welcome window's colours and measures. */
export const WELCOME = {
  /** The tagline, the wordmark and the close button. */
  ink: BRAND_COLORS.ink,
  /** "Create account", "Explore the app" and "Sign in". */
  accent: BRAND_COLORS.frontHill,
  /** "Already have an account?" */
  quiet: '#2C3550',
  /** Behind the photo while it loads: its sky. */
  backdrop: '#CADDEA',
  /** From the window's top edge to the wordmark. */
  topPadding: 56,
  /** Between the wordmark and the tagline. */
  wordmarkGap: 40,
  /** Between the tagline and the actions. */
  taglineGap: 32,
  wordmarkWidth: 150,
} as const

/** The "Horizon" wordmark at the top of the welcome window. */
export function WelcomeWordmark() {
  return (
    <HorizonWordmark
      width={WELCOME.wordmarkWidth}
      fill={WELCOME.ink}
      role="img"
      aria-label={PRODUCT_NAME}
    />
  )
}

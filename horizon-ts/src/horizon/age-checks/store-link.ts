import {Linking} from 'react-native'

import {logger} from '#/logger'
import {IS_ANDROID} from '#/env'

const PACKAGE = 'app.nearhorizon'

/**
 * Opens Horizon in the phone's store, where Play asks the user to confirm
 * their age or a parent approves the app.
 */
export async function openInStore() {
  const url = IS_ANDROID
    ? `market://details?id=${PACKAGE}`
    : 'itms-apps://apps.apple.com/'
  try {
    await Linking.openURL(url)
  } catch (err) {
    logger.warn('age check: could not open the store', {
      safeMessage: (err as Error)?.message,
    })
    if (IS_ANDROID) {
      await Linking.openURL(
        `https://play.google.com/store/apps/details?id=${PACKAGE}`,
      ).catch(() => {})
    }
  }
}

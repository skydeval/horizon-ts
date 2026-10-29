import {GEOLOCATION_URL, IS_WEB} from '#/env'
import {type Geolocation} from '#/geolocation/types'

/*
 * HORIZON: on web, Horizon's own endpoint on the same site
 * (`functions/horizon-geolocation.ts`): Bluesky's service answers only pages
 * from bsky.app. The app has no such limit and keeps Bluesky's.
 */
export const GEOLOCATION_SERVICE_URL = IS_WEB
  ? '/horizon-geolocation'
  : `${GEOLOCATION_URL}/geolocation`

/**
 * Default geolocation config.
 */
export const FALLBACK_GEOLOCATION_SERVICE_RESPONSE: Geolocation = {
  countryCode: undefined,
  regionCode: undefined,
  city: undefined,
}

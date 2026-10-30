/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {type Service} from '@atproto/lex'

/** Horizon's push service. */
export const HORIZON_PUSH_DID = 'did:web:push.nearhorizon.app'

/** The service entry a PDS forwards registrations to. */
export const HORIZON_PUSH_SERVICE: Service = `${HORIZON_PUSH_DID}#horizon_push`

/**
 * Whether push goes to Horizon's service. Always, in Horizon; a typed
 * `boolean` so the stock Bluesky branches beside it stay checked.
 */
export const HORIZON_PUSH_SERVICE_ACTIVE: boolean = true

/** The app id the push service accepts. */
export const HORIZON_PUSH_APP_ID = 'app.nearhorizon'

/** The background task that turns a "check" message into notifications. */
export const HORIZON_PUSH_TASK = 'horizon-push-check'

/** The timed background task that looks for new DMs. */
export const HORIZON_DM_TASK = 'horizon-dm-check'

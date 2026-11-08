/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {type Env} from './hub'
import {handleRequest} from './routes'

export {Hub} from './hub'

function hub(env: Env) {
  return env.HUB.get(env.HUB.idFromName('hub'))
}

export default {
  async fetch(request, env): Promise<Response> {
    return handleRequest(request, hub(env), {sources: env.NOTIFY_SOURCES})
  },

  /** Every minute: make sure the listener is up (the alarm is the first line). */
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(hub(env).ensureRunning())
  },
} satisfies ExportedHandler<Env>

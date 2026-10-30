/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/*
 * The background task for Horizon's push service. It must be defined when
 * the bundle loads (the app entry imports this file), because Android can
 * start the JS runtime just to run it, with no UI.
 */

import * as Notifications from 'expo-notifications'
import * as TaskManager from 'expo-task-manager'

import {logger} from '#/logger'
import {PUSH_OFF} from '#/horizon/switches'
import {checkAccount} from './check'
import {HORIZON_PUSH_TASK} from './config'
import {checkedDid} from './payload'

if (!PUSH_OFF) {
  TaskManager.defineTask(HORIZON_PUSH_TASK, async ({data, error}) => {
    if (error) return
    const did = checkedDid(data)
    if (did) await checkAccount(did)
  })
}

/** Register the task with expo-notifications; safe to call more than once. */
export async function registerPushTask() {
  if (PUSH_OFF) return
  try {
    await Notifications.registerTaskAsync(HORIZON_PUSH_TASK)
  } catch (e) {
    logger.warn('push task registration failed', {
      message: e instanceof Error ? e.message : String(e),
    })
  }
}

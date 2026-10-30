/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/*
 * The background tasks for Horizon's push. They must be defined when the
 * bundle loads (the app entry imports this file), because Android can start
 * the JS runtime just to run them, with no UI.
 *
 * - The push task runs when a "check" message arrives: it checks that
 *   account's notifications and DMs.
 * - The timed task runs about every 15 minutes (Android's floor, less often
 *   when the phone is idle) for what never reaches the push service: DMs,
 *   and kryphocron notifications until prism sends its own wakes.
 */

import * as BackgroundTask from 'expo-background-task'
import * as Notifications from 'expo-notifications'
import * as TaskManager from 'expo-task-manager'

import {logger} from '#/logger'
import * as persisted from '#/state/persisted'
import {canAccountAct} from '#/horizon/session/accounts'
import {PUSH_OFF} from '#/horizon/switches'
import {checkAccount, ready} from './check'
import {HORIZON_DM_TASK, HORIZON_PUSH_TASK} from './config'
import {checkedDid} from './payload'

/** Minutes between DM checks; Android's floor is 15. */
const DM_INTERVAL_MINUTES = 15

if (!PUSH_OFF) {
  TaskManager.defineTask(HORIZON_PUSH_TASK, async ({data, error}) => {
    if (error) return
    const did = checkedDid(data)
    if (did) await checkAccount(did, {activity: true, private: true, dms: true})
  })

  TaskManager.defineTask(HORIZON_DM_TASK, async () => {
    try {
      if (!(await Notifications.getPermissionsAsync()).granted) {
        return BackgroundTask.BackgroundTaskResult.Success
      }
      await ready()
      const accounts = persisted.get('session').accounts.filter(canAccountAct)
      for (const account of accounts) {
        // kryphocron too, until prism wakes phones itself
        await checkAccount(account.did, {activity: false, private: true, dms: true})
      }
      return BackgroundTask.BackgroundTaskResult.Success
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed
    }
  })
}

function warn(what: string, e: unknown) {
  logger.warn(`push: ${what} failed`, {
    message: e instanceof Error ? e.message : String(e),
  })
}

/** Register both tasks; safe to call more than once. */
export async function registerPushTask() {
  if (PUSH_OFF) return
  try {
    await Notifications.registerTaskAsync(HORIZON_PUSH_TASK)
  } catch (e) {
    warn('push task registration', e)
  }
  try {
    if (!(await TaskManager.isTaskRegisteredAsync(HORIZON_DM_TASK))) {
      await BackgroundTask.registerTaskAsync(HORIZON_DM_TASK, {
        minimumInterval: DM_INTERVAL_MINUTES,
      })
    }
  } catch (e) {
    warn('DM task registration', e)
  }
}

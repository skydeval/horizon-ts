/*
 * Generated from patch-notes/*.md by scripts/horizon-patch-notes.js.
 * Do not edit; run `node scripts/horizon-patch-notes.js generate`.
 */

import {type PatchNote} from './types'

export const PATCH_NOTES: readonly PatchNote[] = [
  {
    "version": "0.1.25",
    "build": 25,
    "date": "2026-11-20",
    "summary": "Horizon's own moderation, more reliable blocks, and quieter threads.",
    "sections": [
      {
        "kind": "horizon",
        "items": [
          "Horizon's own moderation is built in next to Bluesky's: always on, and offered whenever you report something.",
          "Your reports on kryphocron posts appear in the moderation inbox under Your reports → Private, with their review status and outcome.",
          "Public or Private is now a small drop-down in the composer that shows the current choice. It's filled in for Private, so you can tell at a glance."
        ]
      },
      {
        "kind": "fixes",
        "items": [
          "Blocks Bluesky misses now count. For members, Horizon also checks who blocks you and whom you block, including through lists Bluesky can't find.",
          "Threads no longer show a Thread Lens notice. When Thread Lens can't answer, the thread quietly tries again every few seconds."
        ]
      }
    ]
  }
]

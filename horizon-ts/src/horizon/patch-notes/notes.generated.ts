/*
 * Generated from patch-notes/*.md by scripts/horizon-patch-notes.js.
 * Do not edit; run `node scripts/horizon-patch-notes.js generate`.
 */

import {type PatchNote} from './types'

export const PATCH_NOTES: readonly PatchNote[] = [
  {
    "version": "0.1.15",
    "build": 15,
    "date": "2026-11-04",
    "summary": "Push notifications now arrive within seconds, and Horizon post links show their link cards in Discord.",
    "sections": [
      {
        "kind": "horizon",
        "items": [
          "Horizon post links shared in Discord show the post's link card: its title, description and site, beside the thumbnail."
        ]
      },
      {
        "kind": "fixes",
        "items": [
          "Push notifications for likes, replies, reposts, follows, mentions and quotes now arrive within seconds, without waiting for Bluesky. Your mutes, blocks and push settings still apply.",
          "The emoji picker on the web remembers the emoji you use, and shows a new pick the next time you open it.",
          "Thread Lens shows a deleted post as \"Deleted post\" instead of \"Post hidden by a block\", with the thread's first post still shown above it."
        ]
      }
    ]
  }
]

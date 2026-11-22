/*
 * Generated from patch-notes/*.md by scripts/horizon-patch-notes.js.
 * Do not edit; run `node scripts/horizon-patch-notes.js generate`.
 */

import {type PatchNote} from './types'

export const PATCH_NOTES: readonly PatchNote[] = [
  {
    "version": "0.1.27",
    "build": 27,
    "date": "2026-11-21",
    "summary": "Cards for lists, feeds and starter packs in Discord and other chat apps, and a blocks fix.",
    "sections": [
      {
        "kind": "horizon",
        "items": [
          "List, custom feed and starter pack links now show a card in Discord and other chat apps: the name, owner, description and size, with the list's or feed's picture or a starter pack's first members."
        ]
      },
      {
        "kind": "fixes",
        "items": [
          "A list Bluesky's moderators took down no longer blocks anyone."
        ]
      }
    ]
  }
]

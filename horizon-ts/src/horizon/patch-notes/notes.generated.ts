/*
 * Generated from patch-notes/*.md by scripts/horizon-patch-notes.js.
 * Do not edit; run `node scripts/horizon-patch-notes.js generate`.
 */

import {type PatchNote} from './types'

export const PATCH_NOTES: readonly PatchNote[] = [
  {
    "version": "0.1.16",
    "build": 16,
    "date": "2026-11-05",
    "summary": "Pronouns you save in Horizon now show in Bluesky's app too.",
    "sections": [
      {
        "kind": "horizon",
        "items": [
          "Saving your pronouns in Horizon also fills in Bluesky's profile pronouns, in its own form (\"she/her\", or \"she/they\" for several sets), so people using Bluesky's app see them. Horizon still shows them in full.",
          "The reply composer shows the pronouns of the person you're replying to."
        ]
      }
    ]
  }
]

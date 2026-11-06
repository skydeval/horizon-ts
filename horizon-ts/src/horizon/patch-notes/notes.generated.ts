/*
 * Generated from patch-notes/*.md by scripts/horizon-patch-notes.js.
 * Do not edit; run `node scripts/horizon-patch-notes.js generate`.
 */

import {type PatchNote} from './types'

export const PATCH_NOTES: readonly PatchNote[] = [
  {
    "version": "0.1.19",
    "build": 19,
    "date": "2026-11-05",
    "summary": "Deactivated accounts' profiles say so straight away.",
    "sections": [
      {
        "kind": "fixes",
        "items": [
          "Opening a deactivated account's profile now says \"Account is deactivated\" straight away, instead of loading, then saying it can't be found, then loading again."
        ]
      }
    ]
  }
]

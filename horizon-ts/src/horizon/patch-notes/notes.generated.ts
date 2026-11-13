/*
 * Generated from patch-notes/*.md by scripts/horizon-patch-notes.js.
 * Do not edit; run `node scripts/horizon-patch-notes.js generate`.
 */

import {type PatchNote} from './types'

export const PATCH_NOTES: readonly PatchNote[] = [
  {
    "version": "0.1.24",
    "build": 24,
    "date": "2026-11-12",
    "summary": "Longer sign-ins and reporting for kryphocron posts.",
    "sections": [
      {
        "kind": "fixes",
        "items": [
          "Horizon no longer signs you out every week or two. After this update, the Android app asks you to sign in once more.",
          "If a sign-in does end, signing back in is one tap.",
          "Kryphocron posts can be reported from the ••• menu.",
          "Creating a bsky.social account on the website now sends you to bsky.app, instead of stopping after the captcha."
        ]
      }
    ]
  }
]

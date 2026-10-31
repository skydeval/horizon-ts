/*
 * Generated from patch-notes/*.md by scripts/horizon-patch-notes.js.
 * Do not edit; run `node scripts/horizon-patch-notes.js generate`.
 */

import {type PatchNote} from './types'

export const PATCH_NOTES: readonly PatchNote[] = [
  {
    "version": "0.1.0",
    "build": 8,
    "date": "2026-10-30",
    "summary": "Notifications on Android, Horizon's own look, the moderation inbox, and the latest from Bluesky's app.",
    "sections": [
      {
        "kind": "horizon",
        "items": [
          "Push notifications on Android, for likes, reposts, replies, quotes, mentions and follows.",
          "Replies and mentions on kryphocron posts notify you within seconds.",
          "Direct messages and kryphocron notifications are checked about every 15 minutes.",
          "Horizon has its own app icon, notification icon and launch screen.",
          "Android builds can be downloaded from nearhorizon.app/download, and Obtainium can keep them up to date.",
          "Patch notes, at nearhorizon.app/patch-notes and in Settings, About."
        ]
      },
      {
        "kind": "upstream",
        "items": [
          "The moderation inbox: see the reports you've made and any moderation decisions about your account, in Settings, Moderation.",
          "A trending topics widget for your Android home screen.",
          "Notifications line up with the feed, and the Activity tab is now called Post alerts.",
          "Links can open a profile straight to one of its tabs, such as its lists.",
          "Tabs with something unread show a dot."
        ]
      },
      {
        "kind": "fixes",
        "items": [
          "Videos in the Following feed no longer go black and stop partway through, and the feed no longer jitters, flashes or reloads while you scroll.",
          "Saving an image gives it the same file name every time, so saving it twice won't make two copies under different names.",
          "On Android, saved images go to a Horizon album instead of a Bluesky one.",
          "The Android app's composer has the spoiler and content warning buttons, as on the web, for public and kryphocron posts.",
          "The Android app no longer links to Bluesky's help desk, status page and feedback form, until Horizon has its own.",
          "Two-factor codes from an authenticator app are handled properly when signing in.",
          "Ordinary GitHub links on profiles are no longer treated as payment links. GitHub Sponsors links still are."
        ]
      }
    ]
  }
]

/*
 * The current account's "Cover ||spoilers|| from other apps" choice, held
 * for the renderers (change list item 2). `OtherAppSpoilersSync` (in
 * `HorizonHost`, and the native `App.tsx`) feeds it from the account's
 * posting defaults record (`reading.otherAppSpoilers`), the device copy
 * first. On by default, signed out included.
 */

import {useSyncExternalStore} from 'react'
import {type RichText as RichTextAPI} from '@bsky/sdk/richtext'

import {OTHER_APP_SPOILERS, SPOILER_TAGS} from '#/horizon/switches'
import {withOtherAppSpoilers} from './other-apps'

let setting = true
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSetting(): boolean {
  return setting
}

/** Set the current account's choice; renderers that read it update. */
export function setOtherAppSpoilersSetting(value: boolean): void {
  if (setting === value) return
  setting = value
  for (const listener of listeners) listener()
}

/** The switches allow spoilers from other apps at all. */
export function otherAppSpoilersAvailable(): boolean {
  return SPOILER_TAGS && OTHER_APP_SPOILERS
}

/**
 * Spoilers from other apps are drawn now, for code outside React (the video
 * card's text).
 */
export function otherAppSpoilersOn(): boolean {
  return otherAppSpoilersAvailable() && setting
}

/** As `otherAppSpoilersOn`, re-rendering when the choice changes. */
export function useOtherAppSpoilersOn(): boolean {
  const value = useSyncExternalStore(subscribe, getSetting, getSetting)
  return otherAppSpoilersAvailable() && value
}

/**
 * The text a `RichText` renders (hook Spoil 1): a post's text with its
 * `||...||` pairs from another app drawn as spoilers while the account's
 * choice is on; any other text unchanged.
 */
export function useOtherAppSpoilers(richText: RichTextAPI): RichTextAPI {
  return withOtherAppSpoilers(richText, useOtherAppSpoilersOn())
}

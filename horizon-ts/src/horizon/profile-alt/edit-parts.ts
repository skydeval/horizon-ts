/*
 * The avatar and banner descriptions' state in the stock Edit Profile
 * dialog, which holds it: `dirty` joins its dirty check, `imageChanged` is
 * called when an image is picked or removed (a new image drops its
 * description), and `save()` runs after the profile is saved, so the new
 * images' CIDs are known.
 */

import {useState} from 'react'

import {MAX_ALT_TEXT} from '#/lib/constants'
import {useSession} from '#/state/session'
import {useOwnWriter} from '#/horizon/identity/edit/own'
import {
  altForImage,
  PROFILE_IMAGE_SLOTS,
  type ProfileImageSlot,
} from '#/horizon/profile-alt/parse'
import {useProfileAltQuery} from '#/horizon/profile-alt/query'
import {
  type ProfileAltTexts,
  readOwnProfileImageCids,
  saveProfileAlt,
} from '#/horizon/profile-alt/write'
import {PROFILE_ALT_TEXT} from '#/horizon/switches'

export type Slots<T> = Partial<Record<ProfileImageSlot, T>>

/** The descriptions' state, for the stock Edit Profile dialog. */
export type ProfileAltEditParts = ReturnType<typeof useProfileAltEditParts>

/**
 * The description fields' state for `profile` (the account's own). Each
 * starts from the record's description of the image the profile has now,
 * and empty for a new image.
 */
export function useProfileAltEditParts(profile: {
  did: string
  avatar?: string
  banner?: string
}) {
  const {currentAccount} = useSession()
  const enabled = PROFILE_ALT_TEXT && currentAccount?.did === profile.did
  const query = useProfileAltQuery(enabled ? profile.did : undefined)
  const writer = useOwnWriter()
  const [edited, setEdited] = useState<Slots<string>>({})
  const [replaced, setReplaced] = useState<Slots<boolean>>({})
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const answer = query.data
  const initial = (slot: ProfileImageSlot) =>
    altForImage(answer?.record, slot, profile[slot]) ?? ''
  const text = (slot: ProfileImageSlot) =>
    edited[slot] ?? (replaced[slot] ? '' : initial(slot))
  const texts: ProfileAltTexts = {
    avatar: text('avatar'),
    banner: text('banner'),
  }

  const dirty =
    enabled &&
    !!answer &&
    PROFILE_IMAGE_SLOTS.some(slot => texts[slot].trim() !== initial(slot))
  const invalid =
    enabled && PROFILE_IMAGE_SLOTS.some(s => texts[s].length > MAX_ALT_TEXT)

  const setText = (slot: ProfileImageSlot, next: string) => {
    setError('')
    setEdited(prev => ({...prev, [slot]: next}))
  }

  const imageChanged = (slot: ProfileImageSlot) => {
    setReplaced(prev => ({...prev, [slot]: true}))
    setEdited(prev => {
      const next = {...prev}
      delete next[slot]
      return next
    })
  }

  const save = async () => {
    if (!dirty) return
    if (!writer || !answer) throw new Error('Descriptions are not ready')
    setSaving(true)
    try {
      const cids = await readOwnProfileImageCids(writer)
      await saveProfileAlt(writer, answer, texts, cids)
      setEdited({})
      setReplaced({})
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      throw e
    } finally {
      setSaving(false)
    }
  }

  return {
    enabled,
    state: answer
      ? ('ready' as const)
      : query.isError
        ? ('error' as const)
        : ('loading' as const),
    retry: () => void query.refetch(),
    texts,
    dirty,
    invalid,
    saving,
    error,
    setText,
    imageChanged,
    save,
  }
}

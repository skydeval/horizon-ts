/*
 * The web emoji picker's "Frequently used" row (emoji-mart 5).
 *
 * emoji-mart seeds an empty row with nine starter emoji scored 9 down to 1,
 * and counts each pick as 1, so an emoji you use ranks below every starter
 * until you have used it many times. Horizon drops the starters, so the row
 * holds only what you use. emoji-mart also removes an empty row for the rest
 * of the page load, so the row is put back after a pick.
 */

/** emoji-mart's storage key for the row. */
export const FREQUENT_KEY = 'emoji-mart.frequently'

/**
 * emoji-mart's starters, in order: the first `perLine` (9) of
 * `FrequentlyUsed.DEFAULTS`, each seeded with the score `9 - index`.
 */
export const STARTER_EMOJI = [
  '+1',
  'grinning',
  'kissing_heart',
  'heart_eyes',
  'laughing',
  'stuck_out_tongue_winking_eye',
  'sweat_smile',
  'joy',
  'scream',
] as const

/**
 * Before emoji-mart first reads the row: start a new row empty, and drop
 * every starter still at its seeded score, which means it was never picked.
 * A starter you picked has a higher score and stays.
 */
export function dropStarterEmoji(storage: Storage | undefined) {
  if (!storage) return
  try {
    const raw = storage.getItem(FREQUENT_KEY)
    if (raw === null) {
      storage.setItem(FREQUENT_KEY, '{}')
      return
    }
    const index: unknown = JSON.parse(raw)
    if (typeof index !== 'object' || index === null || Array.isArray(index)) {
      return
    }
    const scores = index as Record<string, unknown>
    let changed = false
    STARTER_EMOJI.forEach((id, i) => {
      if (scores[id] === STARTER_EMOJI.length - i) {
        delete scores[id]
        changed = true
      }
    })
    if (changed) storage.setItem(FREQUENT_KEY, JSON.stringify(scores))
  } catch {
    // Storage blocked or a value emoji-mart can't read either; leave it.
  }
}

/**
 * After a pick: put the row back in emoji-mart's categories if it was
 * removed for being empty, so the next picker opened shows the pick. The
 * picker drops it again if it is still empty.
 */
export function restoreFrequentRow(data: {categories?: {id: string}[]}) {
  const categories = data?.categories
  if (!categories || categories.some(category => category.id === 'frequent')) {
    return
  }
  categories.unshift({id: 'frequent', emojis: []} as {id: string})
}

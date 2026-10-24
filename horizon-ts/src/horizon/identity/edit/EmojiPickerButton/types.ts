/** An emoji chosen in a picker. */
export type PickedEmoji = {
  /** The emoji itself, e.g. "🌿". */
  native: string
  /**
   * Its name, when the picker gives one (emoji-mart on web does; the native
   * pickers return only the character, which screen readers name anyway).
   */
  name?: string
}

export type EmojiPickerButtonProps = {
  onPick: (emoji: PickedEmoji) => void
  testID?: string
}

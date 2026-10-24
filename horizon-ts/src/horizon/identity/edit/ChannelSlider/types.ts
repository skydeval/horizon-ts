export type ChannelSliderProps = {
  /** The accessible name, e.g. "Hue". */
  label: string
  value: number
  min: number
  max: number
  /** The arrow-key and swipe step. */
  step?: number
  /** The Page Up / Page Down step. */
  pageStep?: number
  /** The value read out, e.g. "210 degrees". */
  valueText: string
  onChange: (value: number) => void
  /** Colours along the track, left to right. */
  track: readonly string[]
  testID?: string
}

/** `value` held to `min`..`max` and rounded to whole steps. */
export function clampStep(
  value: number,
  min: number,
  max: number,
  step: number,
): number {
  const stepped = Math.round((value - min) / step) * step + min
  return Math.max(min, Math.min(max, stepped))
}

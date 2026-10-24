export type CustomColorSwatchProps = {
  /** The current colour as `#RRGGBB`, or empty when there is none or it is invalid. */
  color: string
  /** The accessible name, including the colour in words. */
  label: string
  onChange: (hex: string) => void
  /** Whether the slider panel is open (native toggles it from the swatch). */
  expanded: boolean
  onToggleSliders: () => void
  testID?: string
}

/*
 * The phone frame prototype's picker (Phase 3 design, 9.7, Q2). Not a
 * switch: it chooses whether Appearance shows "Phone frame" (Bars or
 * Buttons). Once skydeval has picked, this goes false and the default
 * `frameStyle` in `appearance/device-value.ts` becomes the pick.
 */

/** Appearance shows the "Phone frame" picker. */
export const SHOW_FRAME_STYLE_PICKER: boolean = true

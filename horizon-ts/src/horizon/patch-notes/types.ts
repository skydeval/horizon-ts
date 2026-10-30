/** A patch notes section: what we built, what came from Bluesky, fixes. */
export type PatchNoteKind = 'horizon' | 'upstream' | 'fixes'

/** One release's notes, from `patch-notes/<version>-<build>.md`. */
export type PatchNote = {
  version: string
  build: number
  /** `YYYY-MM-DD` */
  date: string
  summary?: string
  sections: {kind: PatchNoteKind; items: string[]}[]
}

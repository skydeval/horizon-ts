/*
 * The Reddit-style spoiler syntax `>!...!<`, accepted as a second way to
 * write a spoiler (skydeval, 2026-10-18). It is converted to `||...||` before
 * a post is parsed for spoilers and when it is published, so every record
 * carries `||` and every client sees one syntax. Both markers are two
 * characters, so the conversion never changes a post's length.
 */

const OPEN = '>!'
const CLOSE = '!<'

/**
 * `text` with each matched `>!...!<` pair written as `||...||`.
 *
 * Pairs are matched left to right: an opener takes the first closer after
 * it. A pair is converted only when its content holds something other than
 * whitespace and holds no `||` of its own (which would pair with the new
 * markers instead). An opener with no closer, and a closer with no opener,
 * stay as typed, so text like `hi!<3` is untouched.
 */
export function convertAltSpoilers(text: string): string {
  if (!text.includes(OPEN) || !text.includes(CLOSE)) return text
  let out = ''
  let i = 0
  while (i < text.length) {
    const open = text.indexOf(OPEN, i)
    if (open === -1) break
    const close = text.indexOf(CLOSE, open + OPEN.length)
    if (close === -1) break
    const content = text.slice(open + OPEN.length, close)
    if (content.trim() === '' || content.includes('||')) {
      // Not a spoiler: keep the opener and look for the next one after it.
      out += text.slice(i, open + OPEN.length)
      i = open + OPEN.length
      continue
    }
    out += `${text.slice(i, open)}||${content}||`
    i = close + CLOSE.length
  }
  return out + text.slice(i)
}

/*
 * The text of a crash for the stack shown in test builds (`ErrorStack`).
 */

/** Frames kept from each end; a stack overflow repeats the middle. */
const HEAD = 40
const TAIL = 20

/**
 * The lines of `text`, or the first and last of them around a count of
 * those left out.
 */
export function trimLines(text: string | undefined): string {
  if (!text) return ''
  const lines = text.split('\n').filter(line => line.trim() !== '')
  if (lines.length <= HEAD + TAIL) return lines.join('\n')
  return [
    ...lines.slice(0, HEAD),
    `… ${lines.length - HEAD - TAIL} more …`,
    ...lines.slice(-TAIL),
  ].join('\n')
}

/**
 * The stack text for an error and its component stack.
 */
export function describeCrash(error: unknown, componentStack?: string): string {
  const stack = error instanceof Error ? error.stack : undefined
  const parts = [String(error), trimLines(stack)]
  if (componentStack) parts.push(`Components:\n${trimLines(componentStack)}`)
  return parts.filter(Boolean).join('\n\n')
}

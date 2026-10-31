import {describe, expect, it} from '@jest/globals'

import {spoilerWrapText} from '../spoiler-text'

function apply(marked: string) {
  // `[` and `]` mark the selection; `|` alone marks a cursor
  const start = marked.indexOf('[')
  const text = marked.replace('[', '').replace(']', '')
  const end = marked.indexOf(']') - 1
  const result = spoilerWrapText(text, {start, end})
  const {start: s, end: e} = result.selection
  return `${result.text.slice(0, s)}[${result.text.slice(s, e)}]${result.text.slice(e)}`
}

describe('spoilerWrapText', () => {
  it('wraps a selection and keeps it selected inside the markers', () => {
    expect(apply('the [ending] is sad')).toBe('the ||[ending]|| is sad')
  })

  it('inserts an empty pair at the cursor, with the cursor inside', () => {
    expect(apply('a []b')).toBe('a ||[]||b')
    expect(apply('[]')).toBe('||[]||')
  })

  it('unwraps a selection that sits between markers', () => {
    expect(apply('the ||[ending]|| is sad')).toBe('the [ending] is sad')
  })

  it('unwraps a selection that includes its markers', () => {
    expect(apply('the [||ending||] is sad')).toBe('the [ending] is sad')
  })

  it('is the inverse of itself', () => {
    const once = spoilerWrapText('plot twist', {start: 5, end: 10})
    const twice = spoilerWrapText(once.text, once.selection)
    expect(twice.text).toBe('plot twist')
    expect(twice.selection).toEqual({start: 5, end: 10})
  })

  it('handles a backwards or out-of-range selection', () => {
    expect(spoilerWrapText('abc', {start: 3, end: 1}).text).toBe('a||bc||')
    expect(spoilerWrapText('abc', {start: 9, end: 9}).text).toBe('abc||||')
  })
})

import {describe, expect, it} from '@jest/globals'

import {fetchUntilItems, MAX_PAGES_PER_LOAD} from '../feed/paging'

/**
 * Fixed pages keyed by the cursor that asks for them ('' for the first).
 */
function pages(table: Record<string, {items: number[]; cursor?: string}>) {
  const asked: string[] = []
  const fetchPage = (cursor: string | undefined) => {
    asked.push(cursor ?? '')
    const page = table[cursor ?? '']
    if (!page) return Promise.reject(new Error(`no page ${cursor}`))
    return Promise.resolve(page)
  }
  return {fetchPage, asked}
}

describe('fetchUntilItems (prism paging, reply-2)', () => {
  it('follows empty pages while a cursor comes back, and stops at the first page with items', async () => {
    const {fetchPage, asked} = pages({
      '': {items: [], cursor: 'a'},
      a: {items: [], cursor: 'b'},
      b: {items: [1, 2], cursor: 'c'},
      c: {items: [3]},
    })
    const res = await fetchUntilItems(fetchPage, undefined)
    expect(res).toEqual({items: [1, 2], cursor: 'c', pages: 3})
    expect(asked).toEqual(['', 'a', 'b'])
  })

  it('a short page with a cursor is not the end; only an absent cursor is', async () => {
    const {fetchPage} = pages({
      '': {items: [1], cursor: 'a'},
      a: {items: []},
    })
    const first = await fetchUntilItems(fetchPage, undefined)
    expect(first.cursor).toBe('a')
    const second = await fetchUntilItems(fetchPage, first.cursor)
    expect(second).toEqual({items: [], cursor: undefined, pages: 1})
  })

  it('caps a run of empty pages per load and hands back the cursor to continue from', async () => {
    const table: Record<string, {items: number[]; cursor?: string}> = {}
    for (let i = 0; i < 25; i++) {
      table[i === 0 ? '' : `c${i}`] = {items: [], cursor: `c${i + 1}`}
    }
    table.c25 = {items: [7]}
    const {fetchPage, asked} = pages(table)
    const first = await fetchUntilItems(fetchPage, undefined)
    expect(first.items).toEqual([])
    expect(first.pages).toBe(MAX_PAGES_PER_LOAD)
    expect(first.cursor).toBe(`c${MAX_PAGES_PER_LOAD}`)
    let cursor = first.cursor
    let items: number[] = []
    for (let load = 0; load < 5 && cursor; load++) {
      const next = await fetchUntilItems(fetchPage, cursor)
      items = items.concat(next.items)
      cursor = next.cursor
    }
    expect(items).toEqual([7])
    expect(cursor).toBeUndefined()
    expect(new Set(asked).size).toBe(asked.length)
  })

  it('applies the filter, and keeps going past a page it empties', async () => {
    const {fetchPage} = pages({
      '': {items: [1, 3], cursor: 'a'},
      a: {items: [2, 5, 4], cursor: 'b'},
    })
    const res = await fetchUntilItems(fetchPage, undefined, {
      keep: n => n % 2 === 0,
    })
    expect(res.items).toEqual([2, 4])
    expect(res.cursor).toBe('b')
  })

  it('treats a page that repeats its own cursor as the end', async () => {
    const {fetchPage, asked} = pages({
      '': {items: [], cursor: 'a'},
      a: {items: [], cursor: 'a'},
    })
    const res = await fetchUntilItems(fetchPage, undefined)
    expect(res.cursor).toBeUndefined()
    expect(asked).toEqual(['', 'a'])
  })
})

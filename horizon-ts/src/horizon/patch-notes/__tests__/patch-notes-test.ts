/* oxlint-disable import/no-nodejs-modules -- reads the generated file as text, in jest only */
import * as fs from 'node:fs'

import {describe, expect, it} from '@jest/globals'

import {
  GENERATED,
  loadPatchNotes,
  parsePatchNote,
  renderGenerated,
  renderLatestHtml,
} from '../../../../scripts/horizon-patch-notes'
import {PATCH_NOTES} from '../notes.generated'

const NOTE = [
  '---',
  'version: 0.1.0',
  'build: 7',
  'date: 2026-11-02',
  '---',
  '',
  'A short summary.',
  '',
  '## New in Horizon',
  '',
  '- One thing.',
  '- Another <thing>.',
  '',
  '## Fixes',
  '',
  '- A fix.',
  '',
].join('\n')

describe('parsePatchNote', () => {
  it('reads the header, summary and sections in order', () => {
    expect(parsePatchNote('0.1.0-7.md', NOTE)).toEqual({
      version: '0.1.0',
      build: 7,
      date: '2026-11-02',
      summary: 'A short summary.',
      sections: [
        {kind: 'horizon', items: ['One thing.', 'Another <thing>.']},
        {kind: 'fixes', items: ['A fix.']},
      ],
    })
  })

  it('leaves out a missing summary', () => {
    const note = parsePatchNote(
      '0.1.0-7.md',
      NOTE.replace('A short summary.\n', ''),
    )
    expect(note).not.toHaveProperty('summary')
  })

  it.each([
    ['a file name that does not match', '0.1.0-8.md', NOTE],
    ['no header', '0.1.0-7.md', NOTE.replace(/^---\n/, '')],
    ['a bad date', '0.1.0-7.md', NOTE.replace('2026-11-02', 'soon')],
    [
      'an unknown section',
      '0.1.0-7.md',
      NOTE.replace('## Fixes', '## Other stuff'),
    ],
    [
      'sections out of order',
      '0.1.0-7.md',
      NOTE.replace('## New in Horizon', '## Fixes').replace(
        '## Fixes\n\n- A fix.',
        '## New in Horizon\n\n- A fix.',
      ),
    ],
    ['an empty section', '0.1.0-7.md', NOTE.replace('- A fix.\n', '')],
    [
      'loose text in a section',
      '0.1.0-7.md',
      NOTE.replace('- A fix.', 'A fix.'),
    ],
  ])('refuses %s', (_label, name, text) => {
    expect(() => parsePatchNote(name, text)).toThrow(/patch-notes\//)
  })
})

describe('the repo notes', () => {
  it('all parse, newest build first', () => {
    const notes = loadPatchNotes()
    expect(notes.length).toBeGreaterThan(0)
    const builds = notes.map(note => note.build)
    expect(builds).toEqual([...builds].sort((x, y) => y - x))
    expect(new Set(builds).size).toBe(builds.length)
  })

  it('match the generated copy the app bundles', () => {
    expect(fs.readFileSync(GENERATED, 'utf8')).toBe(
      renderGenerated(loadPatchNotes()),
    )
    expect(PATCH_NOTES).toEqual(loadPatchNotes())
  })
})

describe('renderLatestHtml', () => {
  it('shows only the newest release, collapsed, with a link to the page', () => {
    const older = parsePatchNote('0.1.0-7.md', NOTE)
    const newer = {...older, build: 8, summary: 'Newer.'}
    const html = renderLatestHtml([newer, older], 'https://example.com/notes')
    expect(html.startsWith('<details')).toBe(true)
    expect(html).toContain("What's new in build 8")
    expect(html).not.toContain('build 7')
    expect(html).toContain('<a href="https://example.com/notes">')
  })

  it('escapes the text', () => {
    const html = renderLatestHtml([parsePatchNote('0.1.0-7.md', NOTE)])
    expect(html).toContain('Another &lt;thing&gt;.')
    expect(html).not.toContain('<thing>')
  })

  it('is empty without notes', () => {
    expect(renderLatestHtml([])).toBe('')
  })
})

/*
 * Horizon: the patch notes in patch-notes/*.md, for the app and the Android
 * download page.
 *
 *   node scripts/horizon-patch-notes.js generate
 *     writes src/horizon/patch-notes/notes.generated.ts (the app's copy)
 *   node scripts/horizon-patch-notes.js check
 *     fails if that file is out of date
 *   node scripts/horizon-patch-notes.js html-latest [page-url]
 *     prints the newest release as an HTML fragment
 *   node scripts/horizon-patch-notes.js html-build <build> [page-url]
 *     the same for one build; fails when that build has no notes
 *
 * The pure functions are exported for the unit test in
 * src/horizon/patch-notes/__tests__/patch-notes-test.ts, which also keeps
 * the generated file equal to the markdown.
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const NOTES_DIR = path.join(ROOT, 'patch-notes')
const GENERATED = path.join(
  ROOT,
  'src',
  'horizon',
  'patch-notes',
  'notes.generated.ts',
)
const PAGE_URL = 'https://nearhorizon.app/patch-notes'

/** Section headings, in the order they must appear, and their keys. */
const SECTIONS = [
  ['New in Horizon', 'horizon'],
  ['From Bluesky', 'upstream'],
  ['Fixes', 'fixes'],
]

/**
 * One release file as `{version, build, date, summary?, sections}`, where
 * `sections` lists `{kind, items}` in the fixed order. Throws on anything
 * the format doesn't allow, naming the file.
 */
function parsePatchNote(name, text) {
  const fail = message => {
    throw new Error(`patch-notes/${name}: ${message}`)
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[0] !== '---') fail('must start with a --- header')
  const end = lines.indexOf('---', 1)
  if (end < 0) fail('the header has no closing ---')

  const header = {}
  for (const line of lines.slice(1, end)) {
    const match = /^(\w+):\s*(.+)$/.exec(line)
    if (!match) fail(`bad header line: ${line}`)
    header[match[1]] = match[2].trim()
  }
  if (!/^\d+\.\d+\.\d+$/.test(header.version ?? '')) fail('bad version')
  if (!/^\d+$/.test(header.build ?? '')) fail('bad build')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(header.date ?? '')) fail('bad date')
  const build = Number(header.build)
  if (name !== `${header.version}-${build}.md`) {
    fail(`the file name must be ${header.version}-${build}.md`)
  }

  let summary
  const sections = []
  let current
  let lastOrder = -1
  for (const raw of lines.slice(end + 1)) {
    const line = raw.trim()
    if (!line) continue
    const heading = /^##\s+(.+)$/.exec(line)
    if (heading) {
      const order = SECTIONS.findIndex(([title]) => title === heading[1])
      if (order < 0) fail(`unknown section: ${heading[1]}`)
      if (order <= lastOrder) fail(`sections out of order at ${heading[1]}`)
      lastOrder = order
      current = {kind: SECTIONS[order][1], items: []}
      sections.push(current)
      continue
    }
    const item = /^-\s+(.+)$/.exec(line)
    if (item) {
      if (!current) fail('an item before any section')
      current.items.push(item[1])
      continue
    }
    if (current) fail(`not an item: ${line}`)
    if (summary !== undefined) fail('the summary must be one line')
    summary = line
  }
  if (sections.length === 0) fail('no sections')
  for (const section of sections) {
    if (section.items.length === 0) fail(`empty section: ${section.kind}`)
  }

  return {
    version: header.version,
    build,
    date: header.date,
    ...(summary !== undefined ? {summary} : {}),
    sections,
  }
}

/** Every release in `dir`, newest build first. */
function loadPatchNotes(dir = NOTES_DIR) {
  return fs
    .readdirSync(dir)
    .filter(name => name.endsWith('.md') && name !== 'README.md')
    .map(name => parsePatchNote(name, fs.readFileSync(path.join(dir, name), 'utf8')))
    .sort((a, b) => b.build - a.build)
}

/** The app's copy, as the generated TypeScript module. */
function renderGenerated(notes) {
  return [
    '/*',
    ' * Generated from patch-notes/*.md by scripts/horizon-patch-notes.js.',
    ' * Do not edit; run `node scripts/horizon-patch-notes.js generate`.',
    ' */',
    '',
    "import {type PatchNote} from './types'",
    '',
    `export const PATCH_NOTES: readonly PatchNote[] = ${JSON.stringify(notes, null, 2)}`,
    '',
  ].join('\n')
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const SECTION_TITLES = Object.fromEntries(
  SECTIONS.map(([title, kind]) => [kind, title]),
)

/**
 * The newest release as a collapsed `<details>` block, with a link to the
 * full page. Empty when there are no notes.
 */
function renderLatestHtml(notes, pageUrl = PAGE_URL) {
  return notes[0] ? renderReleaseHtml(notes[0], pageUrl) : ''
}

/** One release as a collapsed `<details>` block, with a link to the page. */
function renderReleaseHtml(latest, pageUrl = PAGE_URL) {
  const out = [
    '<details class="notes">',
    `  <summary>What's new in build ${latest.build}</summary>`,
  ]
  if (latest.summary) out.push(`  <p>${escapeHtml(latest.summary)}</p>`)
  for (const section of latest.sections) {
    out.push(`  <h3>${escapeHtml(SECTION_TITLES[section.kind])}</h3>`)
    out.push('  <ul>')
    for (const item of section.items) {
      out.push(`    <li>${escapeHtml(item)}</li>`)
    }
    out.push('  </ul>')
  }
  out.push(
    `  <p><a href="${escapeHtml(pageUrl)}">All patch notes</a></p>`,
    '</details>',
  )
  return out.join('\n')
}

function main(argv) {
  const [command, arg] = argv
  if (command === 'generate') {
    fs.writeFileSync(GENERATED, renderGenerated(loadPatchNotes()))
    console.log(`wrote ${path.relative(ROOT, GENERATED)}`)
    return 0
  }
  if (command === 'check') {
    const want = renderGenerated(loadPatchNotes())
    const have = fs.existsSync(GENERATED) ? fs.readFileSync(GENERATED, 'utf8') : ''
    if (want !== have) {
      console.error('notes.generated.ts is out of date; run generate')
      return 1
    }
    return 0
  }
  if (command === 'html-latest') {
    process.stdout.write(renderLatestHtml(loadPatchNotes(), arg || PAGE_URL))
    return 0
  }
  if (command === 'html-build') {
    const note = loadPatchNotes().find(n => String(n.build) === arg)
    if (!note) {
      console.error(`no patch notes for build ${arg}`)
      return 1
    }
    process.stdout.write(renderReleaseHtml(note, argv[2] || PAGE_URL))
    return 0
  }
  console.error(
    'usage: horizon-patch-notes.js generate|check|html-latest [url]|html-build <build> [url]',
  )
  return 2
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2))
}

module.exports = {
  GENERATED,
  NOTES_DIR,
  SECTIONS,
  loadPatchNotes,
  parsePatchNote,
  renderGenerated,
  renderLatestHtml,
  renderReleaseHtml,
}

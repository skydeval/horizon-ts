import {
  answerKryphocronLabelers,
  subscribeKryphocronLabelers,
} from '#/horizon/kryphocron-labelers'
import {
  canReceiveKryphocronReport,
  isKryphocronReportSubject,
  reportPostCollection,
} from '#/horizon/report/kryphocron-report'

const PP = 'tools.kryphocron.feed.postPrivate'
const BSKY = 'did:plc:ar7c4by46qjdydhdevvrndac'
const PUBLIC_LABELER = 'did:web:labeler.example'
const KRYPHOCRON_LABELER = 'did:web:kryphocron-labeler.example'

describe('reportPostCollection', () => {
  it('names a kryphocron post by its own collection', () => {
    expect(reportPostCollection(`at://did:plc:abc/${PP}/3k2a`)).toBe(PP)
  })

  it('keeps app.bsky.feed.post for public posts', () => {
    expect(
      reportPostCollection('at://did:plc:abc/app.bsky.feed.post/3k2a'),
    ).toBe('app.bsky.feed.post')
  })
})

describe('isKryphocronReportSubject', () => {
  it('matches tools.kryphocron collections only', () => {
    expect(isKryphocronReportSubject(PP)).toBe(true)
    expect(isKryphocronReportSubject('app.bsky.feed.post')).toBe(false)
    expect(isKryphocronReportSubject(undefined)).toBe(false)
  })
})

describe('canReceiveKryphocronReport', () => {
  const base = {nsid: PP, bskyModerationDid: BSKY}

  it('never offers Bluesky moderation', () => {
    expect(
      canReceiveKryphocronReport({...base, did: BSKY, collections: undefined}),
    ).toBe(false)
  })

  it('offers a labeler that lists the collection or omits the list', () => {
    expect(
      canReceiveKryphocronReport({
        ...base,
        did: PUBLIC_LABELER,
        collections: ['app.bsky.feed.post', PP],
      }),
    ).toBe(true)
    expect(
      canReceiveKryphocronReport({
        ...base,
        did: PUBLIC_LABELER,
        collections: undefined,
      }),
    ).toBe(true)
  })

  it('skips a labeler whose list leaves the collection out', () => {
    expect(
      canReceiveKryphocronReport({
        ...base,
        did: PUBLIC_LABELER,
        collections: ['app.bsky.feed.post'],
      }),
    ).toBe(false)
  })

  it('never offers a kryphocron labeler', () => {
    const stop = subscribeKryphocronLabelers(() => {})
    answerKryphocronLabelers('did:plc:me', [KRYPHOCRON_LABELER])
    expect(
      canReceiveKryphocronReport({
        ...base,
        did: KRYPHOCRON_LABELER,
        collections: [PP],
      }),
    ).toBe(false)
    stop()
  })
})

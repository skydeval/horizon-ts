import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals'

/*
 * The announcer (system accounts design 4.6, SAR2-N11; 18
 * "Accessibility"): on web and Android a message goes into a region 150 ms
 * after it is queued, alternating text nodes so a repeat is a change, and
 * waits while something (the Posting as menu) holds it; on iOS it is the
 * system announcement.
 */
import {
  announce,
  ANNOUNCE_DELAY_MS,
  getAnnouncerState,
  holdAnnouncements,
  resetAnnouncerForTests,
  setSystemSpeakerForTests,
} from '../announce'

beforeEach(() => {
  jest.useFakeTimers()
  setSystemSpeakerForTests('regions')
  resetAnnouncerForTests()
})

afterEach(() => {
  resetAnnouncerForTests()
  setSystemSpeakerForTests(undefined)
  jest.useRealTimers()
})

describe('the announcer', () => {
  it('writes 150 ms after queueing, into the polite region or the alert one', () => {
    announce('@lala added to your system accounts')
    expect(getAnnouncerState().polite).toEqual(['', ''])
    jest.advanceTimersByTime(ANNOUNCE_DELAY_MS)
    expect(getAnnouncerState().polite).toEqual([
      '@lala added to your system accounts',
      '',
    ])
    announce('Couldn’t remove @lala. Try again.', 'alert')
    jest.advanceTimersByTime(ANNOUNCE_DELAY_MS)
    expect(getAnnouncerState().alert).toEqual([
      'Couldn’t remove @lala. Try again.',
      '',
    ])
  })

  it('a repeated message alternates text nodes, so it is a change and is spoken again', () => {
    announce('x')
    jest.advanceTimersByTime(ANNOUNCE_DELAY_MS)
    announce('x')
    jest.advanceTimersByTime(ANNOUNCE_DELAY_MS)
    expect(getAnnouncerState().polite).toEqual(['', 'x'])
  })

  it('a message queued while the menu holds the announcer is written after it closes', () => {
    const release = holdAnnouncements()
    announce('@lala is no longer one of your system accounts.')
    jest.advanceTimersByTime(ANNOUNCE_DELAY_MS * 4)
    expect(getAnnouncerState().polite).toEqual(['', ''])
    release()
    jest.advanceTimersByTime(ANNOUNCE_DELAY_MS)
    expect(getAnnouncerState().polite[0]).toBe(
      '@lala is no longer one of your system accounts.',
    )
  })

  it('on iOS the system announcement speaks, and no region is written', () => {
    const spoken: string[] = []
    setSystemSpeakerForTests(message => spoken.push(message))
    announce('@lala added to your system accounts')
    jest.advanceTimersByTime(ANNOUNCE_DELAY_MS)
    setSystemSpeakerForTests('regions')
    expect(spoken).toEqual(['@lala added to your system accounts'])
    // Nothing is written to the regions on iOS.
    expect(getAnnouncerState().polite).toEqual(['', ''])
  })
})

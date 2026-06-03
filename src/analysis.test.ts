import { describe, expect, it } from 'vitest'
import { inferDanceFromHints } from './analysis'

describe('inferDanceFromHints', () => {
  it('detects dance from filename abbreviations', () => {
    expect(
      inferDanceFromHints({ fileName: 'Cd 1 - 13 - Malando - El Choclo (Tg 32).mp3' }).danceType,
    ).toBe('Tango')
  })

  it('detects waltz variants from German abbreviations', () => {
    expect(
      inferDanceFromHints({ fileName: 'Cd 1 - 01 - Clinton Gregory - If I Were A Painting (Lw 28).mp3' }).danceType,
    ).toBe('Waltz')
  })

  it('detects slowfox, quickstep and tango abbreviations', () => {
    expect(
      inferDanceFromHints({ fileName: 'Cd 2 - 01 - Sammy Davis Jr. - Here I\'ll Stay (SF 28).mp3' }).danceType,
    ).toBe('Foxtrot')
    expect(
      inferDanceFromHints({ fileName: 'Cd 2 - 11 - Big Kahuna and The Copa Cat Pack - Hawaiian War Chant (QS 50).mp3' }).danceType,
    ).toBe('Quickstep')
    expect(
      inferDanceFromHints({ title: 'Malando - Tango Des Roses', fileName: 'track.mp3' }).danceType,
    ).toBe('Tango')
  })

  it('detects EWalz and VWalz abbreviation variants', () => {
    expect(
      inferDanceFromHints({ fileName: 'SongName (EWalz 29).mp3' }).danceType,
    ).toBe('Waltz')
    expect(
      inferDanceFromHints({ title: 'Beautiful Song VWalz', fileName: 'track.mp3' }).danceType,
    ).toBe('Viennese Waltz')
  })
})

describe('computeFileHash', () => {
  it('computes correct SHA-256 hash for a File object', async () => {
    const { computeFileHash } = await import('./App')
    const file = new File(['dance music content'], 'test.mp3', { type: 'audio/mpeg' })
    const hash = await computeFileHash(file)
    expect(hash).toBe('0f4b6b246bbe080791e8fd402e1f2d7edcd5e58e7f3d5e212acb64dc5940c9dd')
  })
})

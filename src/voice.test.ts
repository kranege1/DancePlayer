import { describe, expect, it } from 'vitest'
import { parseVoiceIntent } from './voice'

describe('parseVoiceIntent', () => {
  it('parses repeat command', () => {
    expect(parseVoiceIntent('repeat')).toEqual({ type: 'repeatSong' })
    expect(parseVoiceIntent('wiederholen')).toEqual({ type: 'repeatSong' })
  })

  it('parses repeat 30 command variants', () => {
    expect(parseVoiceIntent('repeat 30')).toEqual({ type: 'repeat30' })
    expect(parseVoiceIntent('dreissig sekunden zurueck')).toEqual({ type: 'repeat30' })
  })

  it('parses dance command in english and german', () => {
    expect(parseVoiceIntent('play rumba')).toEqual({ type: 'playDance', danceType: 'Rumba' })
    expect(parseVoiceIntent('spiele tango')).toEqual({ type: 'playDance', danceType: 'Tango' })
  })

  it('parses speed and next commands', () => {
    expect(parseVoiceIntent('slower')).toEqual({ type: 'slower' })
    expect(parseVoiceIntent('tempo hoch')).toEqual({ type: 'faster' })
    expect(parseVoiceIntent('next song')).toEqual({ type: 'nextSong' })
  })
})

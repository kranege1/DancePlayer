import { DANCES, type DanceType } from './types'

export type VoiceIntent =
  | { type: 'slower' }
  | { type: 'faster' }
  | { type: 'nextSong' }
  | { type: 'repeatSong' }
  | { type: 'repeat30' }
  | { type: 'playDance'; danceType: DanceType }
  | { type: 'unknown' }

const danceAliases: Array<[DanceType, string[]]> = [
  ['Samba', ['samba']],
  ['ChaCha', ['chacha', 'cha cha']],
  ['Rumba', ['rumba']],
  ['Paso Doble', ['paso doble', 'pasodoble']],
  ['Jive', ['jive']],
  ['Waltz', ['waltz', 'walz', 'langsamer walzer']],
  ['Tango', ['tango']],
  ['Viennese Waltz', ['viennese waltz', 'wiener walzer']],
  ['Foxtrot', ['foxtrot', 'slow fox', 'slowfox']],
  ['Quickstep', ['quickstep']],
]

const slowerWords = ['slower', 'langsamer', 'etwas langsamer', 'tempo runter']
const fasterWords = ['faster', 'quicker', 'schneller', 'etwas schneller', 'tempo hoch']
const nextWords = ['next song', 'next track', 'naechstes lied', 'naechster titel', 'weiter']
const repeatWords = ['repeat', 'wiederholen', 'nochmal', 'lied wiederholen', 'bitte wiederholen']
const repeat30Words = [
  'repeat 30',
  'repeat thirty',
  'wiederhole 30 sekunden',
  '30 sekunden zurueck',
  'dreissig sekunden zurueck',
  'dreißig sekunden zurueck',
]

function normalizeCommand(input: string) {
  return input
    .toLowerCase()
    .replace(/[.,!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function includesAny(text: string, words: string[]) {
  return words.some((word) => text.includes(word))
}

function parseDance(text: string): DanceType | null {
  const aliasMatch = danceAliases.find(([, aliases]) => aliases.some((alias) => text.includes(alias)))
  if (aliasMatch) {
    return aliasMatch[0]
  }
  const exact = DANCES.find((dance) => text.includes(dance.toLowerCase()))
  return exact ?? null
}

export function parseVoiceIntent(raw: string): VoiceIntent {
  const text = normalizeCommand(raw)

  if (!text) return { type: 'unknown' }

  if (includesAny(text, repeat30Words)) return { type: 'repeat30' }
  if (includesAny(text, repeatWords)) return { type: 'repeatSong' }
  if (includesAny(text, slowerWords)) return { type: 'slower' }
  if (includesAny(text, fasterWords)) return { type: 'faster' }
  if (includesAny(text, nextWords)) return { type: 'nextSong' }

  if (text.includes('play ') || text.includes('spiele ') || text.includes('naechste ')) {
    const dance = parseDance(text)
    if (dance) {
      return { type: 'playDance', danceType: dance }
    }
  }

  return { type: 'unknown' }
}

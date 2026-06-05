export const DANCES = [
  'Samba',
  'ChaCha',
  'Rumba',
  'Paso Doble',
  'Jive',
  'Waltz',
  'Tango',
  'Viennese Waltz',
  'Foxtrot',
  'Quickstep',
  'Other',
] as const

export const DANCE_CATEGORIES: { label: string; dances: readonly DanceType[] }[] = [
  { label: 'Latin',    dances: ['Samba', 'ChaCha', 'Rumba', 'Paso Doble', 'Jive'] },
  { label: 'Standard', dances: ['Waltz', 'Tango', 'Viennese Waltz', 'Foxtrot', 'Quickstep'] },
  { label: 'Other', dances: ['Other'] },
]

export type DanceType = (typeof DANCES)[number]

export type BreakMode = 'silence' | 'countdown' | 'applause'

export interface Track {
  id: string
  title: string
  userConfirmed?: boolean
  artist?: string
  filename?: string
  danceType: DanceType
  bpm?: number
  analysisConfidence?: number
  hasCachedAudio?: boolean
  qualityRating: number
  rhythmRating: number
  durationSec: number
  cueStartSec: number
  targetPlaytimeSec: number
  fadeOutSec: number
  hash?: string
  removedEarlier?: boolean
}

export interface BreakItem {
  id: string
  mode: BreakMode
  durationSec: number
  label: string
}

export type PlaylistEntry =
  | { id: string; type: 'track'; trackId: string }
  | { id: string; type: 'break'; breakItem: BreakItem }

export interface Playlist {
  id: string
  name: string
  entries: PlaylistEntry[]
}

export interface SessionRule {
  danceType: DanceType
  autoBreakEnabled: boolean
  breakDurationSec: number
  breakMode: 'silence' | 'countdown' | 'applause'
  announcementEnabled: boolean
}

export interface AppSettings {
  speedPct: number
  wdsfTimedMode: boolean
  language: 'en' | 'de'
  grokApiKey?: string
  playSequence?: 'default' | 'rating' | 'shuffle'
}

export const WDSF_2025_DEFAULT_PLAYTIMES: Record<DanceType, number> = {
  Samba: 90,
  ChaCha: 90,
  Rumba: 100,
  'Paso Doble': 90,
  Jive: 90,
  Waltz: 90,
  Tango: 90,
  'Viennese Waltz': 90,
  Foxtrot: 90,
  Quickstep: 90,
  Other: 240,
}

export const WDSF_2025_BPM_RANGES: Record<DanceType, { min: number; max: number }> = {
  Samba: { min: 48, max: 52 },
  ChaCha: { min: 30, max: 34 },
  Rumba: { min: 24, max: 27 },
  'Paso Doble': { min: 58, max: 62 },
  Jive: { min: 40, max: 46 },
  Waltz: { min: 27, max: 31 },
  Tango: { min: 31, max: 34 },
  'Viennese Waltz': { min: 56, max: 62 },
  Foxtrot: { min: 27, max: 30 },
  Quickstep: { min: 48, max: 52 },
  Other: { min: 20, max: 200 },
}

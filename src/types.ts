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
  // Social / Club dances
  'Bachata',
  'Salsa',
  'Kizomba',
  'Zouk',
  'Merengue',
  'West Coast Swing',
  'East Coast Swing',
  'Lindy Hop',
  'Charleston',
  'Balboa',
  'Shag',
  'Argentine Tango',
  'Milonga',
  'Vals',
  'Bolero',
  'Mambo',
  'Forró',
  'Lambada',
  'Semba',
  'Cumbia',
  'Country Western Two-Step',
  'Nightclub Two-Step',
  'Polka',
  'Boogie Woogie',
  "Rock 'n' Roll",
  'Other',
] as const

export const DANCE_CATEGORIES: { label: string; dances: readonly DanceType[] }[] = [
  { label: 'Latin',    dances: ['Samba', 'ChaCha', 'Rumba', 'Paso Doble', 'Jive'] },
  { label: 'Standard', dances: ['Waltz', 'Tango', 'Viennese Waltz', 'Foxtrot', 'Quickstep'] },
  { label: 'Social', dances: [
    'Bachata', 'Salsa', 'Kizomba', 'Zouk', 'Merengue',
    'West Coast Swing', 'East Coast Swing', 'Lindy Hop', 'Charleston', 'Balboa', 'Shag',
    'Argentine Tango', 'Milonga', 'Vals', 'Bolero', 'Mambo',
    'Forró', 'Lambada', 'Semba', 'Cumbia',
    'Country Western Two-Step', 'Nightclub Two-Step',
    'Polka', 'Boogie Woogie', "Rock 'n' Roll",
  ]},
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
  Bachata: 240,
  Salsa: 240,
  Kizomba: 240,
  Zouk: 240,
  Merengue: 240,
  'West Coast Swing': 240,
  'East Coast Swing': 240,
  'Lindy Hop': 240,
  Charleston: 240,
  Balboa: 240,
  Shag: 240,
  'Argentine Tango': 240,
  Milonga: 240,
  Vals: 240,
  Bolero: 240,
  Mambo: 240,
  'Forró': 240,
  Lambada: 240,
  Semba: 240,
  Cumbia: 240,
  'Country Western Two-Step': 240,
  'Nightclub Two-Step': 240,
  Polka: 240,
  'Boogie Woogie': 240,
  "Rock 'n' Roll": 240,
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
  Bachata: { min: 24, max: 32 },
  Salsa: { min: 44, max: 52 },
  Kizomba: { min: 24, max: 30 },
  Zouk: { min: 28, max: 36 },
  Merengue: { min: 58, max: 76 },
  'West Coast Swing': { min: 28, max: 44 },
  'East Coast Swing': { min: 36, max: 44 },
  'Lindy Hop': { min: 36, max: 60 },
  Charleston: { min: 44, max: 56 },
  Balboa: { min: 40, max: 70 },
  Shag: { min: 36, max: 50 },
  'Argentine Tango': { min: 28, max: 36 },
  Milonga: { min: 44, max: 56 },
  Vals: { min: 44, max: 56 },
  Bolero: { min: 20, max: 26 },
  Mambo: { min: 44, max: 52 },
  'Forró': { min: 44, max: 60 },
  Lambada: { min: 40, max: 56 },
  Semba: { min: 40, max: 56 },
  Cumbia: { min: 36, max: 52 },
  'Country Western Two-Step': { min: 40, max: 52 },
  'Nightclub Two-Step': { min: 28, max: 38 },
  Polka: { min: 52, max: 68 },
  'Boogie Woogie': { min: 40, max: 52 },
  "Rock 'n' Roll": { min: 40, max: 52 },
  Other: { min: 20, max: 200 },
}

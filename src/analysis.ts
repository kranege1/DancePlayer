import { DANCES, type DanceType } from './types'

export interface RhythmAnalysisResult {
  danceType: DanceType
  confidence: number
}

export interface RhythmAnalysisHints {
  title?: string
  artist?: string
  fileName?: string
  /** Genre / tag strings from an external lookup (e.g. MusicBrainz) */
  genres?: string[]
  /** Dance type hint parsed directly from the filename prefix, e.g. "(Samba, brasilianisch)" */
  danceHint?: string
}

interface DanceScore {
  danceType: DanceType
  score: number
}

const DANCE_KEYWORDS: Record<DanceType, string[]> = {
  Samba: ['samba', 'sb', 'sa'],
  ChaCha: ['chacha', 'cha cha', 'cha-cha', 'ch'],
  Rumba: ['rumba', 'rb', 'ru'],
  'Paso Doble': ['paso doble', 'pasodoble', 'paso-doble', 'pd', 'paso'],
  Jive: ['jive', 'jv'],
  Waltz: ['waltz', 'walzer', 'slow waltz', 'langsamer waltz', 'lw', 'ewalz', 'ewaltz'],
  Tango: ['tango', 'tg'],
  'Viennese Waltz': ['viennese waltz', 'wiener walzer', 'viennese', 'wiener', 'vw', 'ww', 'vwalz', 'vwaltz', 'ewaltz'],
  Foxtrot: ['foxtrot', 'slow fox', 'slowfox', 'sf', 'foxtrott', 'slow'],
  Quickstep: ['quickstep', 'quick step', 'qs'],
  Other: [],
}

const DANCE_PRIORITY: DanceType[] = [
  'Viennese Waltz',
  'Quickstep',
  'Paso Doble',
  'ChaCha',
  'Foxtrot',
  'Waltz',
  'Tango',
  'Samba',
  'Rumba',
  'Jive',
  'Other',
]

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[_\-./]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function scoreDanceFromText(text: string): DanceScore[] {
  const normalized = normalizeText(text)
  return DANCES.map((danceType) => {
    const keywords = DANCE_KEYWORDS[danceType]
    let score = 0

    for (const keyword of keywords) {
      if (!keyword) continue

      if (keyword.length === 2) {
        const pattern = new RegExp(`(^|[^a-z0-9])${keyword}([^a-z0-9]|$)`, 'i')
        if (pattern.test(normalized)) score += 2.2
      } else if (normalized.includes(keyword)) {
        score += keyword.length >= 8 ? 1.2 : 1
      }
    }

    if (danceType === 'ChaCha' && /\bcha\b/.test(normalized)) score += 0.8
    if (danceType === 'Paso Doble' && /\bpaso\b/.test(normalized)) score += 0.5
    if (danceType === 'Waltz' && /\bwaltz\b/.test(normalized)) score += 0.6
    if (danceType === 'Viennese Waltz' && /\bwaltz\b/.test(normalized)) score += 0.35
    if (danceType === 'Foxtrot' && /\bfox\b/.test(normalized)) score += 0.25

    return { danceType, score }
  })
}

function mergeDanceScores(...scoreSets: DanceScore[][]): { danceType: DanceType; confidence: number } {
  const totals = new Map<DanceType, number>()

  for (const scoreSet of scoreSets) {
    for (const item of scoreSet) {
      totals.set(item.danceType, (totals.get(item.danceType) ?? 0) + item.score)
    }
  }

  let bestDance: DanceType = 'Other'
  let bestScore = -Infinity
  let secondBest = -Infinity

  for (const dance of DANCE_PRIORITY) {
    const score = totals.get(dance) ?? 0
    if (score > bestScore) {
      secondBest = bestScore
      bestScore = score
      bestDance = dance
    } else if (score > secondBest) {
      secondBest = score
    }
  }

  for (const dance of DANCES) {
    if (!DANCE_PRIORITY.includes(dance)) {
      const score = totals.get(dance) ?? 0
      if (score > bestScore) {
        secondBest = bestScore
        bestScore = score
        bestDance = dance
      } else if (score > secondBest) {
        secondBest = score
      }
    }
  }

  const confidence = Math.max(0.15, Math.min(0.98, 0.3 + bestScore / 2.5 + Math.max(0, bestScore - secondBest) / 3))
  return { danceType: bestDance, confidence }
}

export function inferDanceFromHints(hints: RhythmAnalysisHints): { danceType: DanceType; confidence: number } {
  const textHints = [hints.title, hints.artist, hints.fileName].filter(Boolean).join(' ')
  const scoreSets: DanceScore[][] = [scoreDanceFromText(textHints)]

  // danceHint from filename prefix (e.g. "(Samba, brasilianisch)") — treated as authoritative
  if (hints.danceHint) {
    const hintScores = scoreDanceFromText(hints.danceHint).map((s) => ({ ...s, score: s.score * 4 }))
    scoreSets.push(hintScores)
  }

  // Genres from external lookup carry extra weight (1.5×) — they are authoritative labels
  if (hints.genres?.length) {
    const genreText = hints.genres.join(' ')
    const genreScores = scoreDanceFromText(genreText).map((s) => ({ ...s, score: s.score * 1.5 }))
    scoreSets.push(genreScores)

    // Direct genre → dance mapping for genres that don't appear in titles/filenames
    // but are reliable MusicBrainz tags. Scores are intentionally high (3–5) to dominate.
    const directScores = scoreDancesFromGenres(hints.genres)
    if (directScores.length) scoreSets.push(directScores)
  }

  return mergeDanceScores(...scoreSets)
}

/**
 * Map MusicBrainz genre/tag strings directly to dance types.
 * Returns an array of DanceScore items with high scores for confident matches.
 */
function scoreDancesFromGenres(genres: string[]): DanceScore[] {
  const totals = new Map<DanceType, number>()

  const add = (dance: DanceType, score: number) => {
    totals.set(dance, (totals.get(dance) ?? 0) + score)
  }

  for (const raw of genres) {
    const g = raw.toLowerCase().trim()

    // ── Exact / strong matches ──────────────────────────────────────────────
    // WDSF ballroom dances
    if (g === 'samba') add('Samba', 5)
    else if (g === 'cha-cha' || g === 'cha cha' || g === 'cha-cha-chá') add('ChaCha', 5)
    else if (g === 'rumba') add('Rumba', 5)
    else if (g === 'paso doble' || g === 'pasodoble') add('Paso Doble', 5)
    else if (g === 'jive') add('Jive', 5)
    else if (g === 'slow waltz' || g === 'waltz' || g === 'ewalz') add('Waltz', 4)
    else if (g === 'viennese waltz' || g === 'vwalz') add('Viennese Waltz', 5)
    else if (g === 'tango (ballroom)' || g === 'ballroom tango') add('Tango', 5)
    else if (g === 'slow foxtrot' || g === 'foxtrot') add('Foxtrot', 4)
    else if (g === 'quickstep') add('Quickstep', 5)

    // ── Softer / genre-family hints (lower scores) ───────────────────────────
    else if (g === 'tango') add('Tango', 2)
    else if (g === 'bossa nova') { add('Samba', 1.5); add('Rumba', 1) }
    else if (g === 'walzer' || g === 'langsamer walzer') add('Waltz', 4)
    else if (g === 'wiener walzer') add('Viennese Waltz', 4)
  }

  return Array.from(totals.entries()).map(([danceType, score]) => ({ danceType, score }))
}

export async function analyzeTrackRhythm(file: File, hints: RhythmAnalysisHints = {}): Promise<RhythmAnalysisResult> {
  void file
  const fallback = inferDanceFromHints(hints)
  return fallback
}

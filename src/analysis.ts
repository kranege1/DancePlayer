import { DANCES, type DanceType } from './types'

export interface RhythmAnalysisResult {
  danceType: DanceType
  confidence: number
}

export interface RhythmAnalysisHints {
  title?: string
  artist?: string
  fileName?: string
}

interface DanceScore {
  danceType: DanceType
  score: number
}

const DANCE_KEYWORDS: Record<DanceType, string[]> = {
  Samba: ['samba', 'sb', 'sa'],
  ChaCha: ['chacha', 'cha cha', 'cha-cha', 'ch'],
  Rumba: ['rumba', 'rb'],
  'Paso Doble': ['paso doble', 'pasodoble', 'paso-doble', 'pd'],
  Jive: ['jive', 'jv'],
  Waltz: ['waltz', 'walzer', 'slow waltz', 'langsamer walzer', 'lw'],
  Tango: ['tango', 'tg'],
  'Viennese Waltz': ['viennese waltz', 'wiener walzer', 'viennese', 'wiener', 'vw', 'ww'],
  Foxtrot: ['foxtrot', 'slow fox', 'slowfox', 'sf', 'foxtrott'],
  Quickstep: ['quickstep', 'quick step', 'qs'],
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

  let bestDance: DanceType = 'Tango'
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
  return mergeDanceScores(scoreDanceFromText(textHints))
}

export async function analyzeTrackRhythm(file: File, hints: RhythmAnalysisHints = {}): Promise<RhythmAnalysisResult> {
  void file
  const fallback = inferDanceFromHints(hints)
  return fallback
}

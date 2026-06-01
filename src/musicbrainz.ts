/**
 * MusicBrainz open API lookup (no API key required).
 * https://musicbrainz.org/doc/MusicBrainz_API
 *
 * Used during import to enrich track metadata (canonical artist, title, tags/genres)
 * so the dance-type classifier can leverage real genre data instead of only filename hints.
 */

export interface MBTrackInfo {
  /** Canonical title from MusicBrainz */
  title: string
  /** Primary credited artist */
  artist: string
  /** Lower-cased genre/tag names returned by MB */
  genres: string[]
  /** How confident we are in this match (0–1) */
  matchConfidence: number
}

const MB_BASE = 'https://musicbrainz.org/ws/2'
const USER_AGENT = 'DancePlayer/1.0 (https://github.com/kranege1/DancePlayer)'

/**
 * Look up a recording on MusicBrainz by artist + title.
 * Returns null when offline, API is unreachable, or no plausible match is found.
 * Always resolves (never throws) so callers can use it as a best-effort enrichment step.
 */
export async function lookupTrackOnMusicBrainz(
  artist: string,
  title: string,
  timeoutMs = 4000,
): Promise<MBTrackInfo | null> {
  try {
    const query = buildLuceneQuery(artist, title)
    const url = `${MB_BASE}/recording/?query=${encodeURIComponent(query)}&limit=5&fmt=json&inc=tags+artist-credits+releases`

    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), timeoutMs)

    let response: Response
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal: controller.signal,
      })
    } finally {
      window.clearTimeout(timer)
    }

    if (!response.ok) return null

    const data = (await response.json()) as MBRecordingSearchResponse
    const recordings = data?.recordings ?? []
    if (!recordings.length) return null

    // Pick the best match by score + artist similarity
    const best = pickBestRecording(recordings, artist, title)
    if (!best) return null

    const canonicalArtist = best['artist-credit']?.[0]?.artist?.name ?? artist
    const canonicalTitle = best.title ?? title

    const genres: string[] = (best.tags ?? [])
      .filter((t) => t.count > 0)
      .sort((a, b) => b.count - a.count)
      .map((t) => t.name.toLowerCase())

    // Score 0-100 from MB, normalise to 0-1
    const matchConfidence = Math.min(1, (best.score ?? 0) / 100)

    return { title: canonicalTitle, artist: canonicalArtist, genres, matchConfidence }
  } catch {
    // Offline, aborted, or parse error — silently return null
    return null
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function buildLuceneQuery(artist: string, title: string): string {
  const safeArtist = escapeLucene(artist)
  const safeTitle = escapeLucene(title)
  if (safeArtist && safeTitle) {
    return `recording:"${safeTitle}" AND artist:"${safeArtist}"`
  }
  if (safeTitle) return `recording:"${safeTitle}"`
  return `recording:"${safeArtist}"`
}

function escapeLucene(value: string): string {
  // Escape Lucene special characters
  return value.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&').trim()
}

function pickBestRecording(
  recordings: MBRecording[],
  queryArtist: string,
  queryTitle: string,
): MBRecording | null {
  const normArtist = normalize(queryArtist)
  const normTitle = normalize(queryTitle)

  let best: MBRecording | null = null
  let bestRank = -1

  for (const rec of recordings) {
    const recArtist = normalize(rec['artist-credit']?.[0]?.artist?.name ?? '')
    const recTitle = normalize(rec.title ?? '')

    const artistSim = stringSimilarity(normArtist, recArtist)
    const titleSim = stringSimilarity(normTitle, recTitle)
    const mbScore = (rec.score ?? 0) / 100

    // Weighted rank: title similarity most important, then MB score, then artist
    const rank = titleSim * 0.5 + mbScore * 0.35 + artistSim * 0.15

    if (rank > bestRank) {
      bestRank = rank
      best = rec
    }
  }

  // Only return if reasonably confident
  return best && bestRank > 0.35 ? best : null
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Dice coefficient similarity between two strings (fast, good for short text) */
function stringSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const bigrams = (s: string) => {
    const set = new Set<string>()
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    return set
  }
  const sa = bigrams(a)
  const sb = bigrams(b)
  let intersection = 0
  for (const bg of sa) if (sb.has(bg)) intersection++
  return (2 * intersection) / (sa.size + sb.size)
}

// ── MusicBrainz JSON types (minimal, only what we use) ─────────────────────

interface MBTag {
  name: string
  count: number
}

interface MBArtistCredit {
  artist?: { name?: string }
}

interface MBRecording {
  id?: string
  title?: string
  score?: number
  tags?: MBTag[]
  'artist-credit'?: MBArtistCredit[]
}

interface MBRecordingSearchResponse {
  recordings?: MBRecording[]
}

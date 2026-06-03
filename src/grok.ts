import type { DanceType } from './types'
import { DANCES } from './types'

export interface GrokTrackInfo {
  title: string
  artist?: string
  danceType?: DanceType
}

const GROK_API_URL = 'https://api.x.ai/v1/chat/completions'

/**
 * Use Grok to parse a batch of filenames into title / artist / dance type.
 * Returns one result per filename in the same order. Null entries mean the API
 * couldn't determine the info for that file.
 */
export async function parseFilenamesWithGrok(
  filenames: string[],
  apiKey: string,
): Promise<(GrokTrackInfo | null)[]> {
  if (!filenames.length) return []

  const danceList = DANCES.join(', ')

  const filenameList = filenames
    .map((name, i) => `${i + 1}. ${name}`)
    .join('\n')

  const prompt = `You are a ballroom and social dance music expert. Parse each filename below into its components.
For each filename output a JSON object on one line with keys: index (number), title (string), artist (string or null), dance (string or null).
dance must be exactly one of: ${danceList}
If you can't determine a field use null. Output only valid JSON lines, no explanation.

Filenames:
${filenameList}`

  const response = await fetch(GROK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'grok-3-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    }),
  })

  if (!response.ok) {
    throw new Error(`Grok API error ${response.status}: ${await response.text()}`)
  }

  const data = (await response.json()) as {
    choices: { message: { content: string } }[]
  }
  const raw = data.choices[0]?.message?.content ?? ''

  // Parse each JSON line
  const results: (GrokTrackInfo | null)[] = filenames.map(() => null)
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = JSON.parse(trimmed) as {
        index: number
        title?: string
        artist?: string | null
        dance?: string | null
      }
      const idx = (parsed.index ?? 0) - 1
      if (idx < 0 || idx >= filenames.length) continue
      const dance = DANCES.find((d) => d === parsed.dance) as DanceType | undefined
      results[idx] = {
        title: parsed.title ?? filenames[idx],
        artist: parsed.artist ?? undefined,
        danceType: dance,
      }
    } catch {
      // skip malformed lines
    }
  }

  return results
}

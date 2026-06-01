import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  DANCES,
  WDSF_2025_DEFAULT_PLAYTIMES,
  type AppSettings,
  type DanceType,
  type Playlist,
  type PlaylistEntry,
  type SessionRule,
  type Track,
} from './types'
import { parseVoiceIntent } from './voice'
import { analyzeTrackRhythm } from './analysis'
import { getAudioFile, saveAudioFile } from './mediaStore'
import { getFadeWindow, getRepeatThirtyStart } from './playbackMath'
import { lookupTrackOnMusicBrainz } from './musicbrainz'

interface SpeechResultItem {
  transcript: string
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<ArrayLike<SpeechResultItem>>
}

interface SpeechRecognitionErrorEventLike {
  error: string
}

interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  maxAlternatives: number
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onspeechstart: (() => void) | null
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

type SpeechConstructor = new () => SpeechRecognitionLike

declare global {
  interface Window {
    SpeechRecognition?: SpeechConstructor
    webkitSpeechRecognition?: SpeechConstructor
  }
}

const STORAGE_KEY = 'danceplayer-metadata-v1'

interface PersistedState {
  tracks: Track[]
  playlist: Playlist
  dancePlaylists: Playlist[]
  savedPlaylists: Playlist[]
  settings: AppSettings
  sessionRule: SessionRule
}

const initialSettings: AppSettings = {
  speedPct: 0,
  wdsfTimedMode: true,
  language: 'en',
}

const initialPlaylist: Playlist = {
  id: 'playlist-main',
  name: 'Practice Queue',
  entries: [],
}

const initialSessionRule: SessionRule = {
  danceType: 'Tango',
  autoBreakEnabled: true,
  breakDurationSec: 50,
  breakMode: 'countdown',
  announcementEnabled: true,
}

function createId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

function clampSpeed(value: number) {
  return Math.max(-50, Math.min(50, value))
}

function sortByTitle(a: Track, b: Track) {
  return a.title.localeCompare(b.title)
}

function getConfidenceLabel(confidence: number) {
  if (confidence >= 0.8) return 'High'
  if (confidence >= 0.6) return 'Medium'
  return 'Low'
}

function isLowConfidenceTrack(track: Track) {
  return (track.analysisConfidence ?? 1) < 0.6
}

// ── Dance type colours — each dance gets a consistent colour everywhere ──
const DANCE_COLORS: Record<DanceType, string> = {
  Samba: '#e67e00',
  ChaCha: '#c0392b',
  Rumba: '#8e44ad',
  'Paso Doble': '#b8860b',
  Jive: '#d81b8a',
  Waltz: '#1565c0',
  Tango: '#37474f',
  'Viennese Waltz': '#00897b',
  Foxtrot: '#2e7d32',
  Quickstep: '#f57c00',
}

// Strip leading track-number prefixes and trailing dance/BPM annotations
function cleanDisplayTitle(raw: string): string {
  let s = raw.trim()
  s = s.replace(/^(\d{1,3}\.?\s*[-\u2013]?\s+|Track\s+\d+\s*[-\u2013]?\s*)/i, '')
  s = s.replace(/[\s\-\u2013]+[\(\[]?(?:[A-Z][a-z]{0,3}\s+\d+|\d+\s*BPM|BPM\s*\d+)[\)\]]?$/i, '')
  s = s.replace(/_/g, ' ').trim()
  return s || raw
}

// Try to extract "Artist - Title" from a bare filename (no extension)
function extractArtistFromFilename(filenameNoExt: string): { title: string; artist?: string } {
  const dashMatch = filenameNoExt.match(/^(.+?)\s*[-\u2013]\s*(.+)$/)
  if (dashMatch) {
    const left = dashMatch[1].trim()
    const right = dashMatch[2].trim()
    const looksLikeDance = /\b(waltz|tango|samba|cha|rumba|paso|jive|foxtrot|quickstep|viennese)\b/i.test(left)
    if (!looksLikeDance && left.length > 1 && right.length > 1) {
      return { title: right, artist: left }
    }
  }
  return { title: filenameNoExt }
}

function App() {
  const [tracks, setTracks] = useState<Track[]>([])
  const [playlist, setPlaylist] = useState<Playlist>(initialPlaylist)
  const [settings, setSettings] = useState<AppSettings>(initialSettings)
  const [sessionRule, setSessionRule] = useState<SessionRule>(initialSessionRule)
  const [status, setStatus] = useState('Ready')
  const [isListening, setIsListening] = useState(false)
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null)
  const [repeatAnnounce, setRepeatAnnounce] = useState('')
  const [_breakSecondsLeft, setBreakSecondsLeft] = useState<number | null>(null)
  const [trackProgress, setTrackProgress] = useState(0) // 0–1
  const [previewingTrackId, setPreviewingTrackId] = useState<string | null>(null)
  const [expandedEntryId, setExpandedEntryId] = useState<string | null>(null)

  const [fileMap, setFileMap] = useState<Record<string, File | undefined>>({})
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<string>>(new Set())

  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null)
  const [dancePlaylists, setDancePlaylists] = useState<Playlist[]>([])
  const [savedPlaylists, setSavedPlaylists] = useState<Playlist[]>([])
  const [activeTab, setActiveTab] = useState<'songs' | 'playlists' | 'player' | 'export'>('songs')

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  // Tracks whether the user *intends* listening to stay on — used for safe auto-restart on iOS
  const intendedListeningRef = useRef(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const previewAudioRef = useRef<HTMLAudioElement>(new Audio())
  const previewObjectUrlRef = useRef<string | null>(null)
  const activeObjectUrlRef = useRef<string | null>(null)
  const breakTimeoutRef = useRef<number | null>(null)
  const breakTickRef = useRef<number | null>(null)
  const trackProgressRef = useRef<number | null>(null)
  const fadeFrameRef = useRef<number | null>(null)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as PersistedState
      setTracks(parsed.tracks ?? [])
      setPlaylist(parsed.playlist ?? initialPlaylist)
      setDancePlaylists(parsed.dancePlaylists ?? [])
      setSavedPlaylists(parsed.savedPlaylists ?? [])
      setSettings(parsed.settings ?? initialSettings)
      setSessionRule(parsed.sessionRule ?? initialSessionRule)
      setStatus('Metadata restored. Cached audio will load on demand from device storage.')
    } catch {
      setStatus('Could not restore saved metadata.')
    }
  }, [])

  useEffect(() => {
    const payload: PersistedState = { tracks, playlist, dancePlaylists, savedPlaylists, settings, sessionRule }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  }, [tracks, playlist, dancePlaylists, savedPlaylists, settings, sessionRule])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.playbackRate = 1 + settings.speedPct / 100
  }, [settings.speedPct])

  useEffect(() => {
    return () => {
      if (activeObjectUrlRef.current) {
        URL.revokeObjectURL(activeObjectUrlRef.current)
      }
      if (breakTimeoutRef.current) {
        window.clearTimeout(breakTimeoutRef.current)
      }
      if (fadeFrameRef.current) {
        cancelAnimationFrame(fadeFrameRef.current)
      }
    }
  }, [])

  const tracksById = useMemo(() => {
    return Object.fromEntries(tracks.map((track) => [track.id, track]))
  }, [tracks])

  // IDs of tracks already placed into dance playlists — they leave the Songs staging area
  const distributedTrackIds = useMemo(() => {
    const ids = new Set<string>()
    for (const dp of dancePlaylists) {
      for (const entry of dp.entries) {
        if (entry.type === 'track') ids.add(entry.trackId)
      }
    }
    return ids
  }, [dancePlaylists])

  const visibleTracks = useMemo(() => {
    // Hide tracks already distributed — Songs tab is a staging area for new imports only
    return tracks.filter((t) => !distributedTrackIds.has(t.id))
  }, [tracks, distributedTrackIds])

  const playableEntries = useMemo(() => {
    return playlist.entries
  }, [playlist.entries])

  const currentIndex = playableEntries.findIndex((entry) => entry.id === activeEntryId)
  // currentEntry/currentTrack removed (shown via pq-active row in Player tab)
  // currentTrack removed (now shown via pq-active row in Player tab)

  function updateTrack(trackId: string, update: Partial<Track>) {
    setTracks((prev) => prev.map((track) => (track.id === trackId ? { ...track, ...update } : track)))
  }

  async function handleImport(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    if (!files.length) return

    const accepted = files.filter((file) => {
      const name = file.name.toLowerCase()
      return ['.mp3', '.wav', '.aac', '.m4a', '.aiff'].some((ext) => name.endsWith(ext))
    })

    if (!accepted.length) {
      setStatus('No supported files selected (mp3, wav, aac, m4a, aiff).')
      return
    }

    // Skip files already in the library (match by filename without extension)
    const existingNames = new Set(
      tracks.map((t) => t.title.trim().toLowerCase())
    )
    const newFiles = accepted.filter((file) => {
      const nameNoExt = file.name.replace(/\.[^.]+$/, '').trim().toLowerCase()
      return !existingNames.has(nameNoExt)
    })
    const skippedCount = accepted.length - newFiles.length
    if (!newFiles.length) {
      setStatus(`All ${accepted.length} file(s) already imported.`)
      event.target.value = ''
      return
    }
    const filesToImport = newFiles

    setImportProgress({ done: 0, total: filesToImport.length })

    const imported: Track[] = []
    const importedMap: Record<string, File | undefined> = {}

    for (let i = 0; i < filesToImport.length; i++) {
      const file = filesToImport[i]
      setImportProgress({ done: i + 1, total: filesToImport.length })
      setStatus(`Analysing ${i + 1} of ${filesToImport.length}: ${file.name.replace(/\.[^.]+$/, '')}`)

      const id = createId('track')
      const temporaryUrl = URL.createObjectURL(file)
      const durationSec = await new Promise<number>((resolve) => {
        const probe = document.createElement('audio')
        probe.preload = 'metadata'
        probe.src = temporaryUrl
        probe.onloadedmetadata = () => resolve(Math.max(0, Math.round(probe.duration || 0)))
        probe.onerror = () => resolve(0)
      })
      URL.revokeObjectURL(temporaryUrl)

      const rawName = file.name.replace(/\.[^.]+$/, '')
      const { title: parsedTitle, artist: parsedArtist } = extractArtistFromFilename(rawName)

      // Step 1: quick local analysis from filename
      const localAnalysis = await analyzeTrackRhythm(file, {
        title: rawName,
        fileName: file.name,
      })

      // Step 2: MusicBrainz web lookup (non-blocking, best-effort, only when online)
      let finalTitle = parsedTitle
      let finalArtist = parsedArtist
      let finalDanceType = localAnalysis.danceType
      let finalConfidence = localAnalysis.confidence

      if (navigator.onLine && parsedArtist) {
        setStatus(`Checking online metadata ${i + 1} of ${filesToImport.length}: ${parsedTitle}`)
        const mbResult = await lookupTrackOnMusicBrainz(parsedArtist, parsedTitle)
        if (mbResult && mbResult.matchConfidence >= 0.5) {
          // Use canonical MB names only if MB is fairly confident
          finalTitle = mbResult.title
          finalArtist = mbResult.artist
          // Re-run analysis enriched with MB genre tags
          if (mbResult.genres.length > 0) {
            const enrichedAnalysis = await analyzeTrackRhythm(file, {
              title: mbResult.title,
              artist: mbResult.artist,
              fileName: file.name,
              genres: mbResult.genres,
            })
            // Only upgrade dance type if the enriched run is more confident
            if (enrichedAnalysis.confidence > localAnalysis.confidence) {
              finalDanceType = enrichedAnalysis.danceType
              finalConfidence = Math.min(0.98, enrichedAnalysis.confidence + 0.05) // small bonus for web-confirmed
            }
          }
        }
      }

      const danceType = finalDanceType

      imported.push({
        id,
        title: finalTitle,
        artist: finalArtist,
        danceType,
        analysisConfidence: finalConfidence,
        hasCachedAudio: true,
        qualityRating: 3,
        rhythmRating: 3,
        durationSec,
        cueStartSec: 0,
        targetPlaytimeSec: WDSF_2025_DEFAULT_PLAYTIMES[danceType],
        fadeOutSec: 3,
      })
      importedMap[id] = file

      try {
        await saveAudioFile(id, file)
      } catch {
        imported[imported.length - 1].hasCachedAudio = false
      }
    }

    setTracks((prev) => [...prev, ...imported].sort(sortByTitle))
    setFileMap((prev) => ({ ...prev, ...importedMap }))
    setImportProgress(null)
    const lowConfidenceCount = imported.filter((track) => isLowConfidenceTrack(track)).length
    const skippedSuffix = skippedCount > 0 ? ` (${skippedCount} already in library, skipped)` : ''
    setStatus(
      lowConfidenceCount > 0
        ? `Imported ${imported.length} track(s). ${lowConfidenceCount} need review in the list.${skippedSuffix}`
        : `Imported ${imported.length} track(s). Dance type auto-detected from file names.${skippedSuffix}`,
    )
    event.target.value = ''
  }

  function toggleTrackSelection(trackId: string) {
    setSelectedTrackIds((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) next.delete(trackId)
      else next.add(trackId)
      return next
    })
  }

  function selectAllFiltered() {
    const ids = visibleTracks.map((t) => t.id)
    setSelectedTrackIds((prev) => {
      const next = new Set(prev)
      ids.forEach((id) => next.add(id))
      return next
    })
  }

  function selectHighConfidence() {
    const ids = visibleTracks.filter((t) => !isLowConfidenceTrack(t)).map((t) => t.id)
    setSelectedTrackIds((prev) => {
      const next = new Set(prev)
      ids.forEach((id) => next.add(id))
      return next
    })
  }

  function clearSelection() {
    setSelectedTrackIds(new Set())
  }

  function addSelectedToPlaylist() {
    if (!selectedTrackIds.size) return
    const newEntries: PlaylistEntry[] = Array.from(selectedTrackIds).map((trackId) => ({
      id: createId('entry-track'),
      type: 'track',
      trackId,
    }))
    setPlaylist((prev) => ({ ...prev, entries: [...prev.entries, ...newEntries] }))
    setStatus(`Added ${newEntries.length} track(s) to playlist.`)
    clearSelection()
  }

  function renameCurrentPlaylist(nextName: string) {
    const trimmed = nextName.trim()
    if (!trimmed) return
    setPlaylist((prev) => ({ ...prev, name: trimmed }))
  }

  function createNewPlaylist() {
    const nextName = window.prompt('Name the new playlist:', playlist.name || '')
    if (!nextName?.trim()) {
      setStatus('Playlist creation cancelled. A playlist name is required.')
      return
    }

    setPlaylist({
      id: createId('playlist'),
      name: nextName.trim(),
      entries: [],
    })
    setActiveEntryId(null)
    clearSelection()
    setStatus(`Created playlist "${nextName.trim()}".`)
  }

  function removePlaylistEntry(entryId: string) {
    setPlaylist((prev) => ({ ...prev, entries: prev.entries.filter((e) => e.id !== entryId) }))
  }

  async function togglePreview(trackId: string) {
    const pa = previewAudioRef.current
    // Stop any running preview
    if (!pa.paused) {
      pa.pause()
      if (previewObjectUrlRef.current) {
        URL.revokeObjectURL(previewObjectUrlRef.current)
        previewObjectUrlRef.current = null
      }
      if (previewingTrackId === trackId) {
        setPreviewingTrackId(null)
        return
      }
    }
    // Start preview for this track
    const file = fileMap[trackId] ?? await getAudioFile(trackId)
    if (!file) { setStatus('Audio file not available for preview.'); return }
    const url = URL.createObjectURL(file)
    previewObjectUrlRef.current = url
    pa.src = url
    const track = tracks.find((t) => t.id === trackId)
    pa.currentTime = track?.cueStartSec ?? 0
    pa.playbackRate = 1
    pa.volume = 0.8
    pa.onended = () => {
      setPreviewingTrackId(null)
      URL.revokeObjectURL(url)
      previewObjectUrlRef.current = null
    }
    await pa.play().catch(() => null)
    setPreviewingTrackId(trackId)
  }

  function saveCurrentPlaylist() {
    if (!playlist.name.trim()) {
      setStatus('Give your playlist a name before saving.')
      return
    }
    setSavedPlaylists((prev) => {
      const exists = prev.findIndex((p) => p.id === playlist.id)
      if (exists >= 0) {
        const next = [...prev]
        next[exists] = { ...playlist }
        return next
      }
      return [...prev, { ...playlist }]
    })
    setStatus(`Playlist "${playlist.name}" saved.`)
  }

  function loadSavedPlaylist(p: Playlist) {
    setPlaylist({ ...p, entries: p.entries.map((e) => ({ ...e })) })
    setActiveEntryId(null)
    setStatus(`Loaded playlist "${p.name}".`)
  }

  function deleteSavedPlaylist(id: string) {
    setSavedPlaylists((prev) => prev.filter((p) => p.id !== id))
  }

  function moveSavedEntry(playlistId: string, fromIndex: number, dir: -1 | 1) {
    const toIndex = fromIndex + dir
    setSavedPlaylists((prev) => prev.map((p) => {
      if (p.id !== playlistId) return p
      if (toIndex < 0 || toIndex >= p.entries.length) return p
      const entries = [...p.entries]
      ;[entries[fromIndex], entries[toIndex]] = [entries[toIndex], entries[fromIndex]]
      return { ...p, entries }
    }))
  }

  function removeSavedEntry(playlistId: string, entryId: string) {
    setSavedPlaylists((prev) => prev.map((p) =>
      p.id === playlistId ? { ...p, entries: p.entries.filter((e) => e.id !== entryId) } : p
    ))
  }

  function distributeToDancePlaylists() {
    const source = selectedTrackIds.size > 0
      ? tracks.filter((t) => selectedTrackIds.has(t.id))
      : tracks
    if (!source.length) return
    const byDance: Partial<Record<DanceType, Track[]>> = {}
    for (const track of source) {
      if (!byDance[track.danceType]) byDance[track.danceType] = []
      byDance[track.danceType]!.push(track)
    }
    setDancePlaylists((prev) => {
      const existingById = Object.fromEntries(prev.map((p) => [p.id, p]))
      const dances = Object.keys(byDance) as DanceType[]
      const updated: Playlist[] = dances.map((dance) => {
        const id = `dance-playlist-${dance}`
        const existing = existingById[id]
        const existingTrackIds = new Set(
          (existing?.entries ?? []).filter((e) => e.type === 'track').map((e) => (e as { trackId: string }).trackId)
        )
        const newEntries = (byDance[dance] ?? [])
          .filter((t) => !existingTrackIds.has(t.id))
          .sort(sortByTitle)
          .map((t) => ({ id: createId('entry-track'), type: 'track' as const, trackId: t.id }))
        return {
          id,
          name: dance,
          entries: [...(existing?.entries ?? []), ...newEntries],
        }
      })
      // keep any dance playlists that weren't in this distribution (shouldn't happen but safe)
      const updatedIds = new Set(updated.map((p) => p.id))
      const kept = prev.filter((p) => !updatedIds.has(p.id))
      return [...updated, ...kept]
    })
    const count = Object.keys(byDance).length
    setStatus(`Distributed ${source.length} track(s) into ${count} dance playlist(s) (no duplicates added).`)
  }

  // ── FR-18 Export / Import ──────────────────────────────────────────────

  function exportPlaylist() {
    const data = { version: 1, type: 'playlist', playlist, tracks }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `danceplayer-playlist-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    setStatus('Playlist exported. Save the file to iCloud Drive for safe-keeping.')
  }

  function exportLibrary() {
    const data = { version: 1, type: 'library', tracks }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `danceplayer-library-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    setStatus('Library metadata exported.')
  }

  function handleImportBackup(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string) as {
          version: number
          type: string
          tracks?: Track[]
          playlist?: Playlist
        }
        if (data.type === 'playlist') {
          if (data.tracks) setTracks((prev) => {
            const existingIds = new Set(prev.map((t) => t.id))
            const merged = [...prev]
            for (const t of data.tracks!) {
              if (!existingIds.has(t.id)) merged.push({ ...t, hasCachedAudio: false })
            }
            return merged.sort(sortByTitle)
          })
          if (data.playlist) setPlaylist(data.playlist)
          setStatus('Playlist restored. Re-import audio files from iCloud Drive if needed.')
        } else if (data.type === 'library') {
          if (data.tracks) setTracks((prev) => {
            const existingIds = new Set(prev.map((t) => t.id))
            const merged = [...prev]
            for (const t of data.tracks!) {
              if (!existingIds.has(t.id)) merged.push({ ...t, hasCachedAudio: false })
            }
            return merged.sort(sortByTitle)
          })
          setStatus('Library metadata restored. Re-import audio files from iCloud Drive to enable playback.')
        } else {
          setStatus('Unrecognised backup file format.')
        }
      } catch {
        setStatus('Could not parse backup file.')
      }
    }
    reader.readAsText(file)
    event.target.value = ''
  }

  // ── Run session break then advance to next entry ─────────────────────
  function runBreakThenAdvance(nextIndex: number, rule: SessionRule) {
    const dur = Math.max(5, Math.min(300, rule.breakDurationSec))
    setBreakSecondsLeft(dur)
    setStatus(`Break: ${dur}s (${rule.breakMode})`)

    // Stop any running audio
    const mainAudio = audioRef.current
    if (mainAudio && !mainAudio.paused) mainAudio.pause()

    // ── Applause ────────────────────────────────────────────────────
    if (rule.breakMode === 'applause') {
      const playApplauseBurst = (burstSec: number) => {
        try {
          const ctx = new AudioContext()
          void ctx.resume()
          const sr = ctx.sampleRate
          const bufSize = Math.ceil(sr * burstSec)
          const buf = ctx.createBuffer(2, bufSize, sr)
          for (let ch = 0; ch < 2; ch++) {
            const data = buf.getChannelData(ch)
            const fadeS = Math.min(sr * 0.8, bufSize)
            for (let i = 0; i < bufSize; i++) {
              const env = i < fadeS ? i / fadeS : i > bufSize - fadeS ? (bufSize - i) / fadeS : 1
              data[i] = (Math.random() * 2 - 1) * env * 0.4
            }
          }
          const src = ctx.createBufferSource()
          src.buffer = buf
          const bp1 = ctx.createBiquadFilter(); bp1.type = 'bandpass'; bp1.frequency.value = 1800; bp1.Q.value = 0.5
          const bp2 = ctx.createBiquadFilter(); bp2.type = 'bandpass'; bp2.frequency.value = 3500; bp2.Q.value = 0.8
          const gain = ctx.createGain(); gain.gain.value = 1.2
          src.connect(bp1); src.connect(bp2); bp1.connect(gain); bp2.connect(gain); gain.connect(ctx.destination)
          src.start()
          src.onended = () => void ctx.close()
        } catch { /* AudioContext blocked */ }
      }
      const burstLen = Math.min(5, dur * 0.3)
      playApplauseBurst(burstLen)
      if (dur > 10) window.setTimeout(() => playApplauseBurst(burstLen), Math.max(0, dur - burstLen) * 1000)
    }

    // ── Countdown ───────────────────────────────────────────────────
    if (rule.breakMode === 'countdown') {
      for (let t = dur; t >= 0; t -= 10) {
        window.setTimeout(() => { if (t === 0 || t === 5 || t % 10 === 0) speak(String(t)) }, (dur - t) * 1000)
      }
    }

    // ── Tick + advance ──────────────────────────────────────────────
    const started = performance.now()
    breakTickRef.current = window.setInterval(() => {
      const left = Math.max(0, Math.ceil(dur - (performance.now() - started) / 1000))
      setBreakSecondsLeft(left)
    }, 500)
    breakTimeoutRef.current = window.setTimeout(() => {
      if (breakTickRef.current) { window.clearInterval(breakTickRef.current); breakTickRef.current = null }
      setBreakSecondsLeft(null)
      void playEntryByIndex(nextIndex)
    }, dur * 1000)
  }

  function previewTrack(trackId: string) {
    const track = tracksById[trackId]
    const file = fileMap[trackId]
    const audio = audioRef.current

    if (!track || !file || !audio) {
      setStatus('Preview unavailable for this track.')
      return
    }

    clearPlaybackTimers()

    if (activeObjectUrlRef.current) {
      URL.revokeObjectURL(activeObjectUrlRef.current)
    }

    const objectUrl = URL.createObjectURL(file)
    activeObjectUrlRef.current = objectUrl
    audio.src = objectUrl
    audio.volume = 1
    audio.playbackRate = 1 + settings.speedPct / 100
    audio.onloadedmetadata = () => {
      audio.currentTime = Math.max(0, track.cueStartSec)
    }
    audio.onended = () => {
      setStatus(`Preview finished: ${track.title}`)
    }
    void audio.play()
    setStatus(`Previewing ${track.title}. Adjust the dance in the list if needed.`)
  }

  function speak(text: string): Promise<void> {
    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = settings.language === 'de' ? 'de-DE' : 'en-US'
      utterance.onend = () => resolve()
      utterance.onerror = () => resolve() // always resolve so playback is never blocked
      window.speechSynthesis.cancel() // clear any queued speech first
      window.speechSynthesis.speak(utterance)
    })
  }

  function clearPlaybackTimers() {
    if (breakTimeoutRef.current) {
      window.clearTimeout(breakTimeoutRef.current)
      breakTimeoutRef.current = null
    }
    if (breakTickRef.current) {
      window.clearInterval(breakTickRef.current)
      breakTickRef.current = null
    }
    if (trackProgressRef.current) {
      cancelAnimationFrame(trackProgressRef.current)
      trackProgressRef.current = null
    }
    if (fadeFrameRef.current) {
      cancelAnimationFrame(fadeFrameRef.current)
      fadeFrameRef.current = null
    }
    setBreakSecondsLeft(null)
    setTrackProgress(0)
  }

  async function playEntryByIndex(index: number) {
    clearPlaybackTimers()
    const entry = playableEntries[index]
    if (!entry) {
      setActiveEntryId(null)
      setStatus('Playlist finished.')
      return
    }

    setActiveEntryId(entry.id)

    if (entry.type === 'break') {
      // ── Stop any currently playing audio ───────────────────────────
      const mainAudio = audioRef.current
      if (mainAudio && !mainAudio.paused) {
        mainAudio.pause()
      }
      // Stop preview audio too
      if (!previewAudioRef.current.paused) {
        previewAudioRef.current.pause()
        setPreviewingTrackId(null)
        if (previewObjectUrlRef.current) {
          URL.revokeObjectURL(previewObjectUrlRef.current)
          previewObjectUrlRef.current = null
        }
      }

      const dur = entry.breakItem.durationSec
      setBreakSecondsLeft(dur)
      setStatus(`Break: ${dur}s (${entry.breakItem.mode})`)

      // ── Applause synthesis ──────────────────────────────────────────
      if (entry.breakItem.mode === 'applause') {
        // Each burst gets its own fresh AudioContext started immediately,
        // avoiding iOS suspend issues with long-delayed ctx.start() calls.
        const playApplauseBurst = (burstSec: number) => {
          try {
            const ctx = new AudioContext()
            void ctx.resume()
            const sr = ctx.sampleRate
            const bufSize = Math.ceil(sr * burstSec)
            const buf = ctx.createBuffer(2, bufSize, sr)
            // Two channels with independent noise for a wider crowd feel
            for (let ch = 0; ch < 2; ch++) {
              const data = buf.getChannelData(ch)
              const fadeS = Math.min(sr * 0.8, bufSize)
              for (let i = 0; i < bufSize; i++) {
                const env = i < fadeS
                  ? i / fadeS
                  : i > bufSize - fadeS
                    ? (bufSize - i) / fadeS
                    : 1
                data[i] = (Math.random() * 2 - 1) * env * 0.4
              }
            }
            const src = ctx.createBufferSource()
            src.buffer = buf
            // Two cascaded bandpass filters: clap body ~1800Hz, presence ~3500Hz
            const bp1 = ctx.createBiquadFilter()
            bp1.type = 'bandpass'
            bp1.frequency.value = 1800
            bp1.Q.value = 0.5
            const bp2 = ctx.createBiquadFilter()
            bp2.type = 'bandpass'
            bp2.frequency.value = 3500
            bp2.Q.value = 0.8
            const gain = ctx.createGain()
            gain.gain.value = 1.2
            src.connect(bp1)
            src.connect(bp2)
            bp1.connect(gain)
            bp2.connect(gain)
            gain.connect(ctx.destination)
            src.start()
            src.onended = () => void ctx.close()
          } catch { /* AudioContext blocked before user gesture */ }
        }

        const burstLen = Math.min(5, dur * 0.3)
        playApplauseBurst(burstLen) // burst at break start
        if (dur > 10) {
          // Schedule end burst via setTimeout so a fresh context is created
          // close to play time (avoids iOS auto-suspend of long-idle contexts)
          window.setTimeout(() => playApplauseBurst(burstLen), Math.max(0, dur - burstLen) * 1000)
        }
      }

      // ── Countdown speech ────────────────────────────────────────────
      if (entry.breakItem.mode === 'countdown') {
        for (let t = dur; t >= 0; t -= 10) {
          const delay = (dur - t) * 1000
          window.setTimeout(() => {
            if (t === 0 || t === 5 || t % 10 === 0) speak(String(t))
          }, delay)
        }
      }

      // ── Per-second tick (drives breakSecondsLeft) ───────────────────
      const started = performance.now()
      breakTickRef.current = window.setInterval(() => {
        const elapsed = (performance.now() - started) / 1000
        const left = Math.max(0, Math.ceil(dur - elapsed))
        setBreakSecondsLeft(left)
      }, 500)

      breakTimeoutRef.current = window.setTimeout(() => {
        if (breakTickRef.current) {
          window.clearInterval(breakTickRef.current)
          breakTickRef.current = null
        }
        setBreakSecondsLeft(null)
        void playEntryByIndex(index + 1)
      }, dur * 1000)
      return
    }

    const track = tracksById[entry.trackId]
    if (!track) {
      setStatus('Track metadata missing. Skipping.')
      void playEntryByIndex(index + 1)
      return
    }

    let file = fileMap[track.id]
    if (!file) {
      file = await getAudioFile(track.id) ?? undefined
      if (file) {
        setFileMap((prev) => ({ ...prev, [track.id]: file! }))
      }
    }

    if (!file) {
      setStatus(`Audio file for ${track.title} missing in memory. Re-import to play.`)
      void playEntryByIndex(index + 1)
      return
    }

    if (sessionRule.announcementEnabled) {
      const phrase = settings.language === 'de' ? `Naechste ${track.danceType}` : `Next ${track.danceType}`
      setRepeatAnnounce(phrase)
      await speak(phrase) // wait for announcement to finish before starting playback
    }

    const audio = audioRef.current
    if (!audio) return

    if (activeObjectUrlRef.current) {
      URL.revokeObjectURL(activeObjectUrlRef.current)
    }

    const objectUrl = URL.createObjectURL(file)
    activeObjectUrlRef.current = objectUrl
    audio.src = objectUrl
    audio.volume = 1
    audio.playbackRate = 1 + settings.speedPct / 100

    audio.onloadedmetadata = () => {
      const startSec = Math.max(0, track.cueStartSec)
      audio.currentTime = startSec

      // ── Track progress RAF ──────────────────────────────────────────
      const progressTick = () => {
        if (!audio || audio.paused || audio.ended) return
        const total = audio.duration || track.durationSec || 1
        setTrackProgress(Math.min(1, (audio.currentTime - startSec) / (total - startSec)))
        trackProgressRef.current = requestAnimationFrame(progressTick)
      }
      trackProgressRef.current = requestAnimationFrame(progressTick)

      if (settings.wdsfTimedMode) {
        const fadeWindow = getFadeWindow(startSec, track.targetPlaytimeSec, track.fadeOutSec)

        const tick = () => {
          if (!audio || audio.paused) return
          if (audio.currentTime >= fadeWindow.fadeStart && audio.currentTime <= fadeWindow.end) {
            const remain = Math.max(0, fadeWindow.end - audio.currentTime)
            audio.volume = Math.max(0, remain / fadeWindow.fade)
          }
          if (audio.currentTime >= fadeWindow.end) {
            audio.pause()
            audio.volume = 1
            if (sessionRule.autoBreakEnabled) {
              runBreakThenAdvance(index + 1, sessionRule)
            } else {
              void playEntryByIndex(index + 1)
            }
            return
          }
          fadeFrameRef.current = requestAnimationFrame(tick)
        }

        fadeFrameRef.current = requestAnimationFrame(tick)
      }
    }

    audio.onended = () => {
      if (sessionRule.autoBreakEnabled) {
        runBreakThenAdvance(index + 1, sessionRule)
      } else {
        void playEntryByIndex(index + 1)
      }
    }
    void audio.play()
    setStatus(`Playing ${track.title} (${track.danceType})`)
  }

  function playFromStart() {
    if (!playableEntries.length) {
      setStatus('No playlist entries to play.')
      return
    }
    void playEntryByIndex(0)
  }

  function nextSong() {
    if (currentIndex < 0) {
      playFromStart()
      return
    }
    void playEntryByIndex(currentIndex + 1)
  }

  function playNextDance(danceType: DanceType) {
    const searchStart = Math.max(0, currentIndex + 1)
    const foundIndex = playableEntries.findIndex((entry, idx) => {
      if (idx < searchStart || entry.type !== 'track') return false
      return tracksById[entry.trackId]?.danceType === danceType
    })

    if (foundIndex >= 0) {
      void playEntryByIndex(foundIndex)
      return
    }

    setStatus(`No ${danceType} track found later in this playlist.`)
  }

  function repeatSong() {
    const audio = audioRef.current
    if (!audio || currentIndex < 0) return
    const entry = playableEntries[currentIndex]
    if (!entry || entry.type !== 'track') return
    const track = tracksById[entry.trackId]
    audio.currentTime = track?.cueStartSec ?? 0
    void audio.play()
    setStatus('Repeat current song.')
  }

  function repeatThirty() {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = getRepeatThirtyStart(audio.currentTime)
    void audio.play()
    setStatus('Repeated last 30 seconds.')
  }

  function applySpeedDelta(delta: number) {
    setSettings((prev) => ({ ...prev, speedPct: clampSpeed(prev.speedPct + delta) }))
  }

  function executeVoiceCommand(text: string) {
    const intent = parseVoiceIntent(text)
    if (intent.type === 'slower') {
      applySpeedDelta(-10)
      setStatus('Voice: slower')
    } else if (intent.type === 'faster') {
      applySpeedDelta(10)
      setStatus('Voice: faster')
    } else if (intent.type === 'nextSong') {
      nextSong()
    } else if (intent.type === 'repeatSong') {
      repeatSong()
    } else if (intent.type === 'repeat30') {
      repeatThirty()
    } else if (intent.type === 'playDance') {
      playNextDance(intent.danceType)
    } else {
      setStatus(`Voice not recognized: ${text}`)
    }
  }

  function stopVoiceListening() {
    intendedListeningRef.current = false
    try { recognitionRef.current?.abort() } catch { /* ignore */ }
    recognitionRef.current = null
    setIsListening(false)
  }

  function startVoiceRecognition() {
    const SpeechRecognitionCtor = (window.SpeechRecognition ?? window.webkitSpeechRecognition) as
      | SpeechConstructor
      | undefined
    if (!SpeechRecognitionCtor) return

    // Always cleanly abort any previous instance before creating a new one.
    // Without this, calling start() on a still-live instance throws InvalidStateError
    // which crashes the React event handler silently on iOS Safari PWA.
    try { recognitionRef.current?.abort() } catch { /* ignore */ }
    recognitionRef.current = null

    const recognition = new SpeechRecognitionCtor()
    recognition.lang = settings.language === 'de' ? 'de-DE' : 'en-US'
    recognition.interimResults = false
    recognition.continuous = true   // keep listening without needing button re-press
    recognition.maxAlternatives = 1

    recognition.onspeechstart = () => {
      setStatus('Listening… speak now')
    }

    recognition.onresult = (event) => {
      // With continuous=true, results accumulate; always read the latest one
      const lastIndex = event.results.length - 1
      const transcript = event.results[lastIndex]?.[0]?.transcript ?? ''
      if (!transcript.trim()) return
      setStatus(`Voice heard: "${transcript}"`)
      executeVoiceCommand(transcript)
    }

    recognition.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setStatus('Microphone access denied. Allow microphone permission in iOS Settings → Safari.')
        intendedListeningRef.current = false
        setIsListening(false)
      } else if (e.error === 'no-speech') {
        // Not a real error — no speech detected in the window; auto-restart below via onend
        setStatus('Voice: no speech detected, still listening…')
      } else if (e.error === 'audio-capture') {
        setStatus('Microphone not available. Another app may be using it.')
        intendedListeningRef.current = false
        setIsListening(false)
      } else {
        setStatus(`Voice error: ${e.error}`)
      }
    }

    recognition.onend = () => {
      // iOS Safari does not honour continuous=true — it stops after each utterance.
      // Auto-restart as long as the user hasn't explicitly stopped.
      if (intendedListeningRef.current) {
        // Small delay avoids tight restart loops on iOS
        window.setTimeout(() => {
          if (intendedListeningRef.current) startVoiceRecognition()
        }, 200)
      } else {
        setIsListening(false)
      }
    }

    recognitionRef.current = recognition
    try {
      recognition.start()
      setIsListening(true)
      setStatus('Voice listening active — speak a command')
    } catch (err) {
      setStatus(`Could not start voice recognition: ${err instanceof Error ? err.message : String(err)}`)
      intendedListeningRef.current = false
      setIsListening(false)
    }
  }

  function toggleVoiceListening() {
    if (!window.isSecureContext) {
      setStatus(
        'Voice commands need HTTPS. Run: npm run build && npm run preview -- --host 0.0.0.0, then open https://YOUR_IP:4173 on iPhone, or use a tunnel like Cloudflare Tunnel.',
      )
      return
    }

    const SpeechRecognitionCtor = (window.SpeechRecognition ?? window.webkitSpeechRecognition) as
      | SpeechConstructor
      | undefined

    if (!SpeechRecognitionCtor) {
      setStatus('Speech recognition is unavailable in this browser.')
      return
    }

    if (intendedListeningRef.current) {
      stopVoiceListening()
      setStatus('Voice listening stopped.')
      return
    }

    intendedListeningRef.current = true
    startVoiceRecognition()
  }

  return (
    <div className="app-shell">
      <header className="hero">
        <p className="kicker">DancePlayer PWA</p>
        <h1>Practice Engine</h1>
        <p className="subtitle">
          Local-first dance playback with WDSF timing, smart breaks, and English/German voice commands.
        </p>
        <div className="status-row">
          <span className="status-pill">{status}</span>
          <span className="status-pill">Speed {settings.speedPct}%</span>
          <span className="status-pill">Mode {settings.wdsfTimedMode ? 'WDSF timed' : 'Full song'}</span>
        </div>
      </header>

      <main className="tab-content">
        {/* ── Songs ── */}
        {activeTab === 'songs' && (
        <section className="panel">
          <h2>Library</h2>
          <label className="file-label" htmlFor="music-files">Import music</label>
          <input id="music-files" type="file" multiple onChange={handleImport} {...{ webkitdirectory: '', mozdirectory: '' } as React.InputHTMLAttributes<HTMLInputElement>} />

          {importProgress && (
            <div className="import-progress">
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${Math.round((importProgress.done / importProgress.total) * 100)}%` }}
                />
              </div>
              <p className="progress-label">
                Analysing {importProgress.done} of {importProgress.total}…
              </p>
            </div>
          )}

          {/* Filter + bulk-add toolbar */}
          {tracks.length > 0 && (
            <div className="lib-toolbar">
              <button type="button" onClick={selectAllFiltered}>
                Select all ({visibleTracks.length})
              </button>
              <button type="button" onClick={selectHighConfidence}>
                High confidence ({visibleTracks.filter((t) => !isLowConfidenceTrack(t)).length})
              </button>
              {selectedTrackIds.size > 0 && (
                <>
                  <button type="button" className="cta" onClick={addSelectedToPlaylist}>
                    Add {selectedTrackIds.size} to playlist
                  </button>
                  <button type="button" onClick={clearSelection}>
                    Clear
                  </button>
                </>
              )}
              {!importProgress && (
                <button type="button" className="cta distribute-btn" onClick={distributeToDancePlaylists}>
                  {selectedTrackIds.size > 0
                    ? `Distribute ${selectedTrackIds.size} selected`
                    : 'Distribute all to dance playlists'}
                </button>
              )}
            </div>
          )}

          {/* Track list */}
          {visibleTracks.length === 0 && tracks.length > 0 && (
            <p className="all-distributed-msg">
              ✓ All {tracks.length} song{tracks.length !== 1 ? 's' : ''} are in Dance Playlists.{' '}
              Go to <strong>Playlists</strong> to build your session, or import more songs here.
            </p>
          )}
          <div className="track-list">
            {visibleTracks.map((track) => (
              <div
                key={track.id}
                className={`track-row ${selectedTrackIds.has(track.id) ? 'selected' : ''} ${isLowConfidenceTrack(track) ? 'needs-review' : ''}`}
                onClick={() => toggleTrackSelection(track.id)}
              >
                <input
                  type="checkbox"
                  checked={selectedTrackIds.has(track.id)}
                  onChange={() => toggleTrackSelection(track.id)}
                  onClick={(e) => e.stopPropagation()}
                />
                <div className="track-info">
                  <span className="track-title">{track.title}</span>
                  <span className="track-meta">
                    <select
                      value={track.danceType}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        const danceType = e.target.value as DanceType
                        updateTrack(track.id, { danceType, targetPlaytimeSec: WDSF_2025_DEFAULT_PLAYTIMES[danceType] })
                      }}
                    >
                      {DANCES.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                    {track.analysisConfidence !== undefined && (
                      <span className={`badge ${track.analysisConfidence >= 0.7 ? 'badge-ok' : 'badge-warn'}`}>
                        {getConfidenceLabel(track.analysisConfidence)} {Math.round(track.analysisConfidence * 100)}%
                      </span>
                    )}
                    {isLowConfidenceTrack(track) && <span className="badge badge-review">Review</span>}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        previewTrack(track.id)
                      }}
                    >
                      Listen
                    </button>
                  </span>
                </div>
                {/* Collapsed edit controls */}
                <details className="track-details" onClick={(e) => e.stopPropagation()}>
                  <summary>Edit</summary>
                  <div className="row compact">
                    <label>
                      Title
                      <input
                        type="text"
                        value={track.title}
                        onChange={(e) => updateTrack(track.id, { title: e.target.value })}
                      />
                    </label>
                    <label>
                      Artist
                      <input
                        type="text"
                        value={track.artist ?? ''}
                        placeholder="Artist name"
                        onChange={(e) => updateTrack(track.id, { artist: e.target.value || undefined })}
                      />
                    </label>
                  </div>
                  <div className="row compact">
                    <label>
                      Cue (s)
                      <input
                        type="number"
                        min={0}
                        step={0.1}
                        value={track.cueStartSec}
                        onChange={(e) => updateTrack(track.id, { cueStartSec: Number(e.target.value) })}
                      />
                    </label>
                    <label>
                      Playtime (s)
                      <input
                        type="number"
                        min={10}
                        value={track.targetPlaytimeSec}
                        onChange={(e) => updateTrack(track.id, { targetPlaytimeSec: Number(e.target.value) })}
                      />
                    </label>
                    <label>
                      Fade (s)
                      <input
                        type="number"
                        min={1}
                        max={10}
                        value={track.fadeOutSec}
                        onChange={(e) => updateTrack(track.id, { fadeOutSec: Number(e.target.value) })}
                      />
                    </label>
                  </div>
                </details>
              </div>
            ))}
          </div>
        </section>
        )}

        {/* ── Playlists ── */}
        {activeTab === 'playlists' && (
        <section className="panel">
          {/* ── Topbar: name + Save + New ── */}
          <div className="playlist-topbar">
            <input
              className="playlist-name-inline"
              value={playlist.name}
              onChange={(e) => renameCurrentPlaylist(e.target.value)}
              placeholder="Playlist name"
            />
            <button type="button" className="cta" onClick={saveCurrentPlaylist}>
              Save
            </button>
            <button type="button" onClick={createNewPlaylist}>
              New
            </button>
          </div>

          {/* ── Saved playlists ── */}
          {savedPlaylists.length > 0 && (
            <>
              <h3 className="saved-playlists-heading">My Playlists</h3>
              <div className="saved-playlists-list">
                {savedPlaylists.map((sp) => (
                  <details key={sp.id} className="saved-playlist-item">
                    <summary className="saved-playlist-summary">
                      <span className="saved-playlist-name">{sp.name}</span>
                      <span className="saved-playlist-count">{sp.entries.length} entries</span>
                      <button
                        type="button"
                        className="cta saved-playlist-load-btn"
                        onClick={(e) => { e.preventDefault(); loadSavedPlaylist(sp) }}
                      >
                        Load
                      </button>
                      <button
                        type="button"
                        className="remove-btn"
                        onClick={(e) => { e.preventDefault(); deleteSavedPlaylist(sp.id) }}
                        aria-label="Delete saved playlist"
                      >
                        ✕
                      </button>
                    </summary>
                    <div className="saved-playlist-entries">
                      {sp.entries.map((entry, idx) => {
                        if (entry.type === 'break') return (
                          <div key={entry.id} className="qe-row qe-break">
                            <span className="qe-num">{idx + 1}</span>
                            <span className="qe-label">⏸ Break {entry.breakItem.durationSec}s</span>
                            <div className="qe-actions">
                              <button type="button" onClick={() => moveSavedEntry(sp.id, idx, -1)} disabled={idx === 0} aria-label="Move up">↑</button>
                              <button type="button" onClick={() => moveSavedEntry(sp.id, idx, 1)} disabled={idx === sp.entries.length - 1} aria-label="Move down">↓</button>
                              <button type="button" className="remove-btn" onClick={() => removeSavedEntry(sp.id, entry.id)} aria-label="Remove">✕</button>
                            </div>
                          </div>
                        )
                        const t = tracksById[entry.trackId]
                        if (!t) return (
                          <div key={entry.id} className="qe-row qe-missing">
                            <span className="qe-num">{idx + 1}</span>
                            <span className="qe-label">Missing</span>
                            <div className="qe-actions">
                              <button type="button" className="remove-btn" onClick={() => removeSavedEntry(sp.id, entry.id)}>✕</button>
                            </div>
                          </div>
                        )
                        return (
                          <div key={entry.id} className="qe-row">
                            <span className="qe-num">{idx + 1}</span>
                            <span className="dance-badge qe-badge" style={{ background: DANCE_COLORS[t.danceType] }}>{t.danceType}</span>
                            <span className="qe-info">
                              <span className="qe-title">{cleanDisplayTitle(t.title)}</span>
                              {t.artist && <span className="qe-artist">{t.artist}</span>}
                            </span>
                            <div className="qe-actions">
                              <button type="button" onClick={() => moveSavedEntry(sp.id, idx, -1)} disabled={idx === 0} aria-label="Move up">↑</button>
                              <button type="button" onClick={() => moveSavedEntry(sp.id, idx, 1)} disabled={idx === sp.entries.length - 1} aria-label="Move down">↓</button>
                              <button type="button" className="remove-btn" onClick={() => removeSavedEntry(sp.id, entry.id)} aria-label="Remove">✕</button>
                            </div>
                          </div>
                        )
                      })}
                      <button
                        type="button"
                        className="cta saved-playlist-update-btn"
                        onClick={() => {
                          setSavedPlaylists((prev) => prev.map((p) => p.id === sp.id ? { ...sp } : p))
                          setStatus(`Saved changes to "${sp.name}".`)
                        }}
                      >
                        Save changes
                      </button>
                    </div>
                  </details>
                ))}
              </div>
            </>
          )}
        </section>
        )}

        {/* ── Player ── */}
        {activeTab === 'player' && (
        <section className="panel">
          <h2 className="player-playlist-title">{playlist.name}</h2>
          <audio ref={audioRef} controls className="audio-player" />
          <div className="row compact">
            <button type="button" onClick={playFromStart}>
              ▶ Play
            </button>
            <button type="button" onClick={nextSong}>
              ⏭ Next
            </button>
            <button type="button" onClick={repeatSong}>
              ↺ Repeat
            </button>
            <button type="button" onClick={repeatThirty}>
              ↩ −30s
            </button>
          </div>

          <div className="row compact speed-row">
            <button type="button" onClick={() => applySpeedDelta(-10)}>
              −10%
            </button>
            <input
              type="range"
              min={-50}
              max={50}
              value={settings.speedPct}
              onChange={(e) => setSettings((prev) => ({ ...prev, speedPct: clampSpeed(Number(e.target.value)) }))}
            />
            <button type="button" onClick={() => applySpeedDelta(10)}>
              +10%
            </button>
          </div>

          <div className="row compact">
            <label className="check">
              <input
                type="checkbox"
                checked={settings.wdsfTimedMode}
                onChange={(e) => setSettings((prev) => ({ ...prev, wdsfTimedMode: e.target.checked }))}
              />
              WDSF timed mode
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={sessionRule.announcementEnabled}
                onChange={(e) => setSessionRule((prev) => ({ ...prev, announcementEnabled: e.target.checked }))}
              />
              Announce next dance
            </label>
          </div>

          {/* Break between tracks — session-level setting, no playlist entries needed */}
          <h3>Break between tracks</h3>
          <div className="row compact">
            <label className="check">
              <input
                type="checkbox"
                checked={sessionRule.autoBreakEnabled}
                onChange={(e) => setSessionRule((prev) => ({ ...prev, autoBreakEnabled: e.target.checked }))}
              />
              Enable break
            </label>
          </div>
          {sessionRule.autoBreakEnabled && (
            <div className="row compact">
              <label>
                Duration (s)
                <input
                  type="number"
                  min={5}
                  max={300}
                  value={sessionRule.breakDurationSec}
                  onChange={(e) => setSessionRule((prev) => ({ ...prev, breakDurationSec: Math.max(5, Math.min(300, Number(e.target.value))) }))}
                />
              </label>
              <label>
                Mode
                <select
                  value={sessionRule.breakMode ?? 'countdown'}
                  onChange={(e) => setSessionRule((prev) => ({ ...prev, breakMode: e.target.value as SessionRule['breakMode'] }))}
                >
                  <option value="silence">Silence</option>
                  <option value="countdown">Countdown</option>
                  <option value="applause">Applause</option>
                </select>
              </label>
            </div>
          )}

          <h3>Voice commands</h3>
          {!window.isSecureContext && (
            <div className="https-warning">
              Voice requires HTTPS. To enable on iPhone: run{' '}
              <code>npx cloudflare tunnel --url http://localhost:5173</code> and open the provided
              https:// address, or use <code>npm run preview -- --https</code>.
            </div>
          )}
          <div className="row compact">
            <label>
              Language
              <select
                value={settings.language}
                onChange={(e) => setSettings((prev) => ({ ...prev, language: e.target.value as 'en' | 'de' }))}
              >
                <option value="en">English</option>
                <option value="de">Deutsch</option>
              </select>
            </label>
            <button
              type="button"
              className={isListening ? 'live' : ''}
              onClick={toggleVoiceListening}
            >
              {isListening ? '🎙 Listening…' : '🎙 Voice Command'}
            </button>
          </div>

          <p className="hint">
            Commands: slower · faster · next song · repeat · repeat 30 · play {'<dance>'}; also
            German variants (langsamer, schneller, nächstes Lied…).
          </p>
          {repeatAnnounce && <p className="hint">Last announcement: {repeatAnnounce}</p>}

          {/* ── Upcoming queue ── */}
          {playlist.entries.length > 0 && (
            <>
              <h3 className="upcoming-heading">
                Up next
                {currentIndex >= 0 && (
                  <span className="upcoming-progress">
                    {currentIndex + 1} / {playlist.entries.length}
                  </span>
                )}
              </h3>
              <div className="player-queue-list">
                {playlist.entries.map((entry, index) => {
                  const isActive = entry.id === activeEntryId
                  const isPast = currentIndex >= 0 && index < currentIndex
                  if (entry.type === 'break') {
                    return (
                      <div
                        key={entry.id}
                        className={`pq-row pq-break${isActive ? ' pq-active' : ''}${isPast ? ' pq-past' : ''}`}
                      >
                        <span className="pq-num">{index + 1}</span>
                        <span className="pq-label">⏸ Break {entry.breakItem.durationSec}s ({entry.breakItem.mode})</span>
                        <button
                          type="button" className="remove-btn"
                          onClick={() => removePlaylistEntry(entry.id)}
                          aria-label="Remove"
                        >✕</button>
                      </div>
                    )
                  }
                  const t = tracksById[entry.trackId]
                  if (!t) return (
                    <div key={entry.id} className="pq-row pq-missing">
                      <span className="pq-num">{index + 1}</span>
                      <span className="pq-label">Missing track</span>
                      <button type="button" className="remove-btn" onClick={() => removePlaylistEntry(entry.id)} aria-label="Remove">✕</button>
                    </div>
                  )
                  return (
                    <div
                      key={entry.id}
                      className={`pq-row${isActive ? ' pq-active' : ''}${isPast ? ' pq-past' : ''}`}
                      onClick={() => void playEntryByIndex(index)}
                    >
                      <span className="pq-num">{index + 1}</span>
                      <span className="dance-badge pq-badge" style={{ background: DANCE_COLORS[t.danceType] }}>
                        {t.danceType}
                      </span>
                      <span className="pq-info">
                        {isActive && <span className="pq-now-playing-label">▶ Now playing</span>}
                        <span className="pq-title">{cleanDisplayTitle(t.title)}</span>
                        {t.artist && <span className="pq-artist">{t.artist}</span>}
                        {isActive && (
                          <div className="pq-progress-bar">
                            <div className="pq-progress-fill pq-track-fill" style={{ width: `${Math.round(trackProgress * 100)}%` }} />
                          </div>
                        )}
                      </span>
                      <button
                        type="button" className="remove-btn"
                        onClick={(e) => { e.stopPropagation(); removePlaylistEntry(entry.id) }}
                        aria-label="Remove"
                      >✕</button>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </section>
        )}

        {/* ── Export ── */}
        {activeTab === 'export' && (
        <section className="panel panel-backup">
          <h2>Backup &amp; Restore</h2>
          <p className="hint">
            Safari PWA storage is not backed up by iCloud. Export your data as JSON and save it to
            iCloud Drive so you can restore after reinstalling or switching devices.
          </p>

          <h3>Export</h3>
          <div className="row compact">
            <button type="button" onClick={exportPlaylist}>
              Export playlist
            </button>
            <button type="button" onClick={exportLibrary}>
              Export library metadata
            </button>
          </div>

          <h3>Import backup</h3>
          <p className="hint">
            Select a previously exported <code>.json</code> file. Audio files are not included —
            re-import them from iCloud Drive separately after restoring.
          </p>
          <label className="file-label" htmlFor="backup-file">
            Choose backup JSON
          </label>
          <input
            id="backup-file"
            type="file"
            accept=".json,application/json"
            onChange={handleImportBackup}
          />
        </section>
        )}
      </main>

      {/* ── Dance Playlists (Playlists tab) ── */}
      {activeTab === 'playlists' && dancePlaylists.length > 0 && (
        <section className="dance-playlists-section">
          <div className="dance-playlists-header">
            <h2>Dance Playlists</h2>
            <button
              type="button"
              onClick={distributeToDancePlaylists}
              title="Re-run distribution to update playlists"
            >
              Refresh
            </button>
          </div>
          <div className="dance-playlists-grid">
            {dancePlaylists.map((dp) => {
              const color = DANCE_COLORS[dp.name as DanceType] ?? '#555'
              return (
                <div key={dp.id} className="dance-playlist-card">
                  <div className="dance-playlist-card-header" style={{ background: color }}>
                    <span className="dance-playlist-card-title">{dp.name}</span>
                    <span className="dance-playlist-card-count">{dp.entries.length} track{dp.entries.length !== 1 ? 's' : ''}</span>
                  </div>
                  <div className="dance-playlist-tracks">
                    {dp.entries.map((entry, idx) => {
                      if (entry.type !== 'track') return null
                      const t = tracksById[entry.trackId]
                      if (!t) return null
                      return (
                        <div key={entry.id} className="dance-playlist-track-row">
                          <span className="dance-track-num">{idx + 1}</span>
                          <div className="dance-track-info">
                            <span className="dance-track-title">{cleanDisplayTitle(t.title)}</span>
                            <span className="dance-track-artist">{t.artist ?? '\u00a0'}</span>
                          </div>
                          {expandedEntryId === entry.id ? (
                            <div className="track-row-actions">
                              <button
                                type="button"
                                className={previewingTrackId === entry.trackId ? 'previewing' : ''}
                                title={previewingTrackId === entry.trackId ? 'Stop preview' : 'Preview'}
                                onClick={(e) => { e.stopPropagation(); void togglePreview(entry.trackId) }}
                              >{previewingTrackId === entry.trackId ? '■' : '▶'}</button>
                              <button
                                type="button"
                                title="Add to queue"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setPlaylist((prev) => ({
                                    ...prev,
                                    entries: [...prev.entries, { id: createId('entry-track'), type: 'track' as const, trackId: entry.trackId }],
                                  }))
                                  setStatus(`Added \u201c${t.title}\u201d to playlist.`)
                                  setExpandedEntryId(null)
                                }}
                              >+</button>
                              <button
                                type="button"
                                title="Remove from dance playlist"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setDancePlaylists((prev) => prev.map((p) =>
                                    p.id === dp.id
                                      ? { ...p, entries: p.entries.filter((en) => en.id !== entry.id) }
                                      : p
                                  ))
                                  setStatus(`Removed \u201c${t.title}\u201d from ${dp.name}.`)
                                  setExpandedEntryId(null)
                                }}
                              >✕</button>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); setExpandedEntryId(null) }}
                              >✕ close</button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="track-row-menu-btn"
                              onClick={(e) => { e.stopPropagation(); setExpandedEntryId(entry.id) }}
                            >⋯</button>
                          )}
                          <details className="track-details dance-track-edit" onClick={(e) => e.stopPropagation()}>
                            <summary title="Edit title / artist">✎</summary>
                            <div className="row compact">
                              <label>
                                Title
                                <input
                                  type="text"
                                  value={t.title}
                                  onChange={(e) => updateTrack(t.id, { title: e.target.value })}
                                />
                              </label>
                              <label>
                                Artist
                                <input
                                  type="text"
                                  value={t.artist ?? ''}
                                  placeholder="Artist name"
                                  onChange={(e) => updateTrack(t.id, { artist: e.target.value || undefined })}
                                />
                              </label>
                            </div>
                          </details>
                        </div>
                      )
                    })}
                  </div>
                  <div className="dance-playlist-card-footer">
                    <button
                      type="button"
                      className="cta"
                      onClick={() => {
                        const newEntries: PlaylistEntry[] = dp.entries
                          .filter((e): e is { id: string; type: 'track'; trackId: string } => e.type === 'track')
                          .map((e) => ({ id: createId('entry-track'), type: 'track' as const, trackId: e.trackId }))
                        setPlaylist((prev) => ({ ...prev, entries: [...prev.entries, ...newEntries] }))
                        setStatus(`Added all ${dp.entries.length} ${dp.name} track(s) to playlist.`)
                      }}
                    >
                      Add all to playlist
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      <nav className="tab-bar" role="tablist" aria-label="Main navigation">
        {([
          { id: 'songs',     label: 'Songs',     icon: '♫' },
          { id: 'playlists', label: 'Playlists', icon: '☰' },
          { id: 'player',    label: 'Player',    icon: '▶' },
          { id: 'export',    label: 'Export',    icon: '⬆' },
        ] as const).map(({ id, label, icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            className={`tab-btn${activeTab === id ? ' active' : ''}`}
            onClick={() => setActiveTab(id)}
          >
            <span className="tab-icon" aria-hidden="true">{icon}</span>
            <span className="tab-label">{label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}

export default App

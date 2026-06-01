import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  DANCES,
  DANCE_CATEGORIES,
  WDSF_2025_DEFAULT_PLAYTIMES,
  type AppSettings,
  type DanceType,
  type Playlist,
  type PlaylistEntry,
  type SessionRule,
  type Track,
} from './types'
import { clearAllAudioFiles, getAudioFile, saveAudioFile } from './mediaStore'
import { parseVoiceIntent } from './voice'
import { analyzeTrackRhythm } from './analysis'
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
  breakDurationSec: 30,
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
  // Also strip inline dance/BPM annotations anywhere in the title, e.g. " (Sb 51)" or "(Ch 32)"
  s = s.replace(/\s*[\(\[][A-Z][a-z]{0,3}\s+\d+[\)\]]/g, '')
  s = s.replace(/_/g, ' ').trim()
  return s || raw
}

function cleanStoredTitle(raw: string): string {
  return cleanDisplayTitle(raw)
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
  const [breakSecondsLeft, setBreakSecondsLeft] = useState<number | null>(null)
  const [breakInfo, setBreakInfo] = useState<{ mode: SessionRule['breakMode']; totalSec: number } | null>(null)
  const [trackProgress, setTrackProgress] = useState(0) // 0–1
  const [previewingTrackId, setPreviewingTrackId] = useState<string | null>(null)
  const [expandedEntryId, setExpandedEntryId] = useState<string | null>(null)
  const [openDanceCards, setOpenDanceCards] = useState<Set<string>>(new Set())

  const [fileMap, setFileMap] = useState<Record<string, File | undefined>>({})
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<string>>(new Set())

  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null)
  const [dancePlaylists, setDancePlaylists] = useState<Playlist[]>([])
  const [savedPlaylists, setSavedPlaylists] = useState<Playlist[]>([])
  const [activeTab, setActiveTab] = useState<'songs' | 'playlists' | 'player' | 'export'>('songs')
  const [editingTrackId, setEditingTrackId] = useState<string | null>(null)

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  // Tracks whether the user *intends* listening to stay on — used for safe auto-restart on iOS
  const intendedListeningRef = useRef(false)
  const sessionRuleRef = useRef<SessionRule>(initialSessionRule)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const previewAudioRef = useRef<HTMLAudioElement>(new Audio())
  const previewObjectUrlRef = useRef<string | null>(null)
  const activeObjectUrlRef = useRef<string | null>(null)
  const breakTimeoutRef = useRef<number | null>(null)
  const breakTickRef = useRef<number | null>(null)
  const breakAudioCtxRef = useRef<AudioContext | null>(null)
  const applauseAudioRefs = useRef<HTMLAudioElement[]>([])
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
    sessionRuleRef.current = sessionRule
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

  const activeDanceType = useMemo(() => {
    const entry = playlist.entries.find((e) => e.id === activeEntryId)
    if (!entry || entry.type !== 'track') return null
    return tracksById[entry.trackId]?.danceType ?? null
  }, [activeEntryId, playlist.entries, tracksById])

  const currentTrack = useMemo(() => {
    const entry = playlist.entries.find((e) => e.id === activeEntryId)
    if (!entry || entry.type !== 'track') return null
    return tracksById[entry.trackId] ?? null
  }, [activeEntryId, playlist.entries, tracksById])

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
        filename: file.name,
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
      const all = [...updated, ...kept]
      // sort by canonical DANCES order
      return all.sort((a, b) => DANCES.indexOf(a.name as DanceType) - DANCES.indexOf(b.name as DanceType))
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
    setBreakInfo({ mode: rule.breakMode, totalSec: dur })
    setStatus(`Break: ${dur}s (${rule.breakMode})`)

    // Stop any running audio
    const mainAudio = audioRef.current
    if (mainAudio && !mainAudio.paused) mainAudio.pause()

    // ── Applause / Silence audio ─────────────────────────────────────
    startBreakAudio(rule.breakMode, dur)

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
      setBreakInfo(null)
      void playEntryByIndex(nextIndex)
    }, dur * 1000)
  }

  async function previewTrack(trackId: string) {
    const track = tracksById[trackId]
    const audio = audioRef.current

    if (!track || !audio) {
      setStatus('Preview unavailable for this track.')
      return
    }

    const file = fileMap[trackId] ?? await getAudioFile(trackId)
    if (!file) {
      setStatus('Audio file not cached — re-import the track to preview it.')
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

  /** Plays Applause.mp3 (once at start, once near the end) or a silent keep-alive for the break. */
  function startBreakAudio(mode: 'applause' | 'silence' | 'countdown', durationSec: number) {
    // Stop any leftover applause from a previous break
    applauseAudioRefs.current.forEach((a) => { a.pause(); a.src = '' })
    applauseAudioRefs.current = []
    if (breakAudioCtxRef.current) { void breakAudioCtxRef.current.close(); breakAudioCtxRef.current = null }
    if (mode !== 'applause' && mode !== 'silence') return

    if (mode === 'silence') {
      // Near-zero WebAudio buffer keeps the iOS audio session alive without audible sound
      try {
        const ctx = new AudioContext()
        void ctx.resume()
        breakAudioCtxRef.current = ctx
        const sr = ctx.sampleRate
        const loopBuf = ctx.createBuffer(1, Math.ceil(sr * 2), sr) // 2-second silent loop
        const src = ctx.createBufferSource()
        src.buffer = loopBuf; src.loop = true
        const g = ctx.createGain(); g.gain.value = 0.0001
        src.connect(g); g.connect(ctx.destination)
        src.start(); src.stop(ctx.currentTime + durationSec)
        src.onended = () => void ctx.close()
      } catch { /* AudioContext unavailable */ }
      return
    }

    // ── Applause.mp3: play → silence for durationSec → play again ──
    const playBurst = (delayMs: number) => {
      const a = new Audio('/Applause.mp3')
      a.volume = 1
      applauseAudioRefs.current.push(a)
      window.setTimeout(() => {
        void a.play().catch(() => null)
      }, delayMs)
      a.onended = () => {
        applauseAudioRefs.current = applauseAudioRefs.current.filter((x) => x !== a)
      }
    }

    // First burst immediately, second burst after durationSec wait
    playBurst(0)
    playBurst(durationSec * 1000)
  }

  function speak(text: string): Promise<void> {
    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text)
      const lang = settings.language === 'de' ? 'de-DE' : 'en-US'
      utterance.lang = lang
      // Prefer a high-quality neural/enhanced voice if available (iOS Siri voices, Google, etc.)
      const voices = window.speechSynthesis.getVoices()
      const preferred = voices.find(
        (v) => v.lang.startsWith(lang.slice(0, 2)) && (v.name.includes('Google') || v.name.includes('Siri') || v.name.includes('Premium') || v.name.includes('Enhanced') || v.name.includes('Neural'))
      ) ?? voices.find((v) => v.lang.startsWith(lang.slice(0, 2)) && v.localService)
      if (preferred) utterance.voice = preferred
      utterance.rate = 0.95
      utterance.pitch = 1.0
      utterance.onend = () => resolve()
      utterance.onerror = () => resolve()
      window.speechSynthesis.cancel()
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
    // Stop any playing applause
    applauseAudioRefs.current.forEach((a) => { a.pause(); a.src = '' })
    applauseAudioRefs.current = []
    if (breakAudioCtxRef.current) { void breakAudioCtxRef.current.close(); breakAudioCtxRef.current = null }
    setBreakSecondsLeft(null)
    setBreakInfo(null)
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

      // ── Applause / Silence audio ─────────────────────────────────────
      startBreakAudio(entry.breakItem.mode, dur)

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
      const phrase = `Next ${track.danceType}`   // always English
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
            const rule = sessionRuleRef.current
            if (rule.autoBreakEnabled) {
              runBreakThenAdvance(index + 1, rule)
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
      const rule = sessionRuleRef.current
      if (rule.autoBreakEnabled) {
        runBreakThenAdvance(index + 1, rule)
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

  function seekBy(deltaSec: number) {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = Math.max(0, audio.currentTime + deltaSec)
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
    // No lang lock — browser/OS default handles both English and German transcription.
    recognition.interimResults = false
    recognition.continuous = true   // mic stays open the whole session
    recognition.maxAlternatives = 3 // more alternatives → better EN+DE matching

    recognition.onspeechstart = () => {
      setStatus('Listening… speak now')
    }

    recognition.onresult = (event) => {
      // Try all alternatives to find a recognized command (covers EN and DE)
      for (let r = event.results.length - 1; r >= 0; r--) {
        const result = event.results[r]
        for (let a = 0; a < result.length; a++) {
          const transcript = result[a]?.transcript ?? ''
          if (!transcript.trim()) continue
          const intent = parseVoiceIntent(transcript)
          if (intent.type !== 'unknown') {
            setStatus(`Voice: "${transcript}"`)
            executeVoiceCommand(transcript)
            return
          }
        }
      }
      // Nothing matched — show what was heard, keep listening
      const last = event.results[event.results.length - 1]?.[0]?.transcript ?? ''
      setStatus(`Voice heard: "${last}" — not recognized`)
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
      // iOS Safari stops after each utterance even with continuous=true — auto-restart.
      if (intendedListeningRef.current) {
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
              {tracks.length > 0 && (
                <button
                  type="button"
                  title="Strip dance codes and track numbers from all stored titles"
                  onClick={() => {
                    let count = 0
                    setTracks((prev) => prev.map((tr) => {
                      const cleaned = cleanStoredTitle(tr.title)
                      // Also clear artist if it's just a bare number (e.g. "08")
                      const artistCleaned = tr.artist && /^\d{1,3}$/.test(tr.artist.trim()) ? undefined : tr.artist
                      if (cleaned !== tr.title || artistCleaned !== tr.artist) { count++ }
                      return { ...tr, title: cleaned, artist: artistCleaned }
                    }))
                    setStatus(`Cleaned ${count} track title${count !== 1 ? 's' : ''}.`)
                  }}
                >
                  ✦ Clean Titles
                </button>
              )}
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
                        void previewTrack(track.id)
                      }}
                    >
                      Listen
                    </button>
                  </span>
                </div>
                {/* Edit button → opens modal */}
                <details className="track-details" onClick={(e) => e.stopPropagation()}>
                  <summary onClick={(e) => { e.preventDefault(); e.stopPropagation(); setEditingTrackId(track.id) }}>Edit</summary>
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

          {/* Saved playlist picker */}
          {(() => {
            const allPlaylists = [
              ...dancePlaylists,
              ...savedPlaylists.filter((sp) => !dancePlaylists.some((dp) => dp.id === sp.id)),
            ]
            if (!allPlaylists.length) return null
            return (
              <div className="player-playlist-picker">
                <select
                  value={allPlaylists.some((p) => p.id === playlist.id) ? playlist.id : ''}
                  onChange={(e) => {
                    const found = allPlaylists.find((p) => p.id === e.target.value)
                    if (found) loadSavedPlaylist(found)
                  }}
                >
                  {!allPlaylists.some((p) => p.id === playlist.id) && (
                    <option value="" disabled>{playlist.name}</option>
                  )}
                  {allPlaylists.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            )
          })()}

          <audio ref={audioRef} controls className="audio-player" />

          {/* Now-playing strip — shows track OR break info */}
          {breakInfo ? (
            <div className="now-playing-strip now-playing-break">
              <div className="now-playing-info">
                <span className="now-playing-title">
                  {breakInfo.mode === 'applause' ? '👏 Applause break' : breakInfo.mode === 'countdown' ? '⏳ Countdown break' : '🔇 Silence break'}
                </span>
                <span className="now-playing-artist">
                  {breakSecondsLeft !== null ? `${breakSecondsLeft}s remaining` : '…'}
                </span>
                <div className="now-playing-breakbar">
                  <div
                    className="now-playing-breakbar-fill"
                    style={{ width: `${breakSecondsLeft !== null ? (breakSecondsLeft / breakInfo.totalSec) * 100 : 0}%` }}
                  />
                </div>
              </div>
              <span className="now-playing-break-badge">{breakInfo.totalSec}s</span>
            </div>
          ) : currentTrack ? (
            <div className="now-playing-strip">
              <div className="now-playing-info">
                <span className="now-playing-title">{cleanDisplayTitle(currentTrack.title)}</span>
                {currentTrack.artist && <span className="now-playing-artist">{currentTrack.artist}</span>}
              </div>
              <span className="dance-badge now-playing-badge" style={{ background: DANCE_COLORS[currentTrack.danceType] }}>
                {currentTrack.danceType}
              </span>
            </div>
          ) : (
            <div className="now-playing-strip now-playing-empty">No track playing</div>
          )}


          {currentTrack && settings.wdsfTimedMode && (() => {
            const dur = currentTrack.durationSec || 1
            const cuePos = (currentTrack.cueStartSec / dur) * 100
            const endSec = Math.min(dur, currentTrack.cueStartSec + currentTrack.targetPlaytimeSec)
            const endPos = (endSec / dur) * 100
            const fmtSec = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
            return (
              <div className="cue-bar-wrap">
                <div className="cue-bar">
                  <div className="cue-bar-active" style={{ left: `${cuePos}%`, width: `${endPos - cuePos}%` }} />
                  <div className="cue-bar-progress" style={{ width: `${trackProgress * 100}%` }} />
                  <div className="cue-marker cue-marker-start" style={{ left: `${cuePos}%` }} title={`Cue: ${fmtSec(currentTrack.cueStartSec)}`} />
                  <div className="cue-marker cue-marker-end" style={{ left: `${endPos}%` }} title={`End: ${fmtSec(endSec)}`} />
                </div>
                <div className="cue-bar-labels">
                  <span>▶ {fmtSec(currentTrack.cueStartSec)}</span>
                  <span>⏹ {fmtSec(endSec)}</span>
                </div>
              </div>
            )
          })()}

          {/* Playback controls */}
          <div className="player-controls">
            <button type="button" className="ctrl-btn" title="Play from start" onClick={playFromStart}>▶</button>
            <button type="button" className="ctrl-btn" title="Next track" onClick={nextSong}>⏭</button>
            <button type="button" className="ctrl-btn" title="Restart track" onClick={repeatSong}>↺</button>
            <button type="button" className="ctrl-btn" title="−15 seconds" onClick={() => seekBy(-15)}>−15s</button>
            <button type="button" className="ctrl-btn" title="+15 seconds" onClick={() => seekBy(15)}>+15s</button>
          </div>

          {/* Speed row */}
          <div className="player-speed-row">
            <button type="button" className="ctrl-btn speed-btn" onClick={() => applySpeedDelta(-10)}>−10%</button>
            <input
              type="range"
              className="speed-slider"
              min={-50}
              max={50}
              value={settings.speedPct}
              onChange={(e) => setSettings((prev) => ({ ...prev, speedPct: clampSpeed(Number(e.target.value)) }))}
            />
            <button type="button" className="ctrl-btn speed-btn" onClick={() => applySpeedDelta(10)}>+10%</button>
            <span className="speed-label">{settings.speedPct > 0 ? '+' : ''}{settings.speedPct}%</span>
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

          {/* Break between tracks */}
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
            <div className="row compact break-settings-row">
              <label>
                Duration
                <select
                  value={sessionRule.breakDurationSec}
                  onChange={(e) => setSessionRule((prev) => ({ ...prev, breakDurationSec: Number(e.target.value) }))}
                >
                  {Array.from({ length: 24 }, (_, i) => (i + 1) * 5).map((s) => (
                    <option key={s} value={s}>{s}s</option>
                  ))}
                </select>
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
            <button
              type="button"
              className={isListening ? 'live' : ''}
              onClick={toggleVoiceListening}
            >
              {isListening ? '🎙 Listening…' : '🎙 Voice Command'}
            </button>
          </div>

          <p className="hint">
            Commands (EN+DE): slower/langsamer · faster/schneller · next song/nächstes Lied · repeat/wiederholen · play {'<dance>'}/spiele {'<dance>'}
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

          <h3>Reset</h3>
          <p className="hint">
            Deletes all songs, playlists, and cached audio. The app returns to its empty default
            state. This cannot be undone.
          </p>
          <button
            type="button"
            className="btn-danger"
            onClick={() => {
              if (!window.confirm('Delete ALL songs, playlists and cached audio?\nThis cannot be undone.')) return
              void clearAllAudioFiles()
              localStorage.removeItem(STORAGE_KEY)
              setTracks([])
              setPlaylist(initialPlaylist)
              setDancePlaylists([])
              setSavedPlaylists([])
              setSettings(initialSettings)
              setSessionRule(initialSessionRule)
              setSelectedTrackIds(new Set())
              setFileMap({})
              setActiveEntryId(null)
              setStatus('App reset to default.')
            }}
          >
            🗑 Reset app to default
          </button>

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
          {DANCE_CATEGORIES.map((cat) => {
            const catPlaylists = cat.dances
              .map((d) => dancePlaylists.find((dp) => dp.name === d))
              .filter(Boolean) as Playlist[]
            if (!catPlaylists.length) return null
            return (
              <div key={cat.label} className="dance-category-group">
                <h3 className="dance-category-label">{cat.label}</h3>
                <div className="dance-playlists-grid">
            {catPlaylists.map((dp) => {
              const color = DANCE_COLORS[dp.name as DanceType] ?? '#555'
              const isOpen = openDanceCards.has(dp.id) || dp.name === activeDanceType
              return (
                <details
                  key={dp.id}
                  className="dance-playlist-card"
                  open={isOpen}
                  onToggle={(e) => {
                    const opened = (e.currentTarget as HTMLDetailsElement).open
                    setOpenDanceCards((prev) => {
                      const next = new Set(prev)
                      if (opened) next.add(dp.id); else next.delete(dp.id)
                      return next
                    })
                  }}
                >
                  <summary className="dance-playlist-card-header" style={{ background: color }}>
                    <span className="dance-playlist-card-title">{dp.name}</span>
                    <span className="dance-playlist-card-count">{dp.entries.length} track{dp.entries.length !== 1 ? 's' : ''}</span>
                  </summary>
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
                          <button
                            type="button"
                            className="track-row-pencil-btn"
                            title="Edit track"
                            onClick={(e) => { e.stopPropagation(); setEditingTrackId(t.id) }}
                          >✎</button>
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
                </details>
              )
            })}
                </div>
              </div>
            )
          })}
        </section>
      )}

      <nav className="tab-bar" role="tablist" aria-label="Main navigation">
        {([
          { id: 'songs',     label: 'Songs',     icon: '♫',  badge: null },
          { id: 'playlists', label: 'Playlists', icon: '☰',  badge: playlist.entries.filter((e) => e.type === 'track').length || null },
          { id: 'player',    label: 'Player',    icon: '▶',  badge: activeEntryId ? playlist.entries.filter((e) => e.type === 'track').length || null : null },
          { id: 'export',    label: 'Export',    icon: '⬆',  badge: null },
        ] as const).map(({ id, label, icon, badge }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            className={`tab-btn${activeTab === id ? ' active' : ''}`}
            onClick={() => setActiveTab(id)}
          >
            <span className="tab-icon-wrap">
              <span className="tab-icon" aria-hidden="true">{icon}</span>
              {badge !== null && <span className="tab-badge">{badge > 99 ? '99+' : badge}</span>}
            </span>
            <span className="tab-label">{label}</span>
          </button>
        ))}
      </nav>

      {/* ── Track Edit Modal ── */}
      {editingTrackId && (() => {
        const t = tracks.find((tr) => tr.id === editingTrackId)
        if (!t) return null
        return (
          <div className="edit-modal-overlay" onClick={() => setEditingTrackId(null)}>
            <div className="edit-modal" onClick={(e) => e.stopPropagation()}>
              <h3 className="edit-modal-title">Edit Track</h3>
              {t.filename && (
                <label className="edit-modal-field">
                  <span className="edit-modal-label">File</span>
                  <input type="text" readOnly value={t.filename} className="edit-modal-input readonly" />
                </label>
              )}
              <label className="edit-modal-field">
                <span className="edit-modal-label">Title</span>
                <input
                  type="text"
                  className="edit-modal-input"
                  value={t.title}
                  onChange={(e) => updateTrack(t.id, { title: e.target.value })}
                />
              </label>
              <label className="edit-modal-field">
                <span className="edit-modal-label">Artist</span>
                <input
                  type="text"
                  className="edit-modal-input"
                  value={t.artist ?? ''}
                  placeholder="Artist name"
                  onChange={(e) => updateTrack(t.id, { artist: e.target.value || undefined })}
                />
              </label>
              <label className="edit-modal-field">
                <span className="edit-modal-label">Dance</span>
                <select
                  className="edit-modal-input"
                  value={t.danceType}
                  onChange={(e) => updateTrack(t.id, { danceType: e.target.value as DanceType })}
                >
                  {DANCES.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </label>
              <div className="edit-modal-row">
                <label className="edit-modal-field half">
                  <span className="edit-modal-label">Cue (s)</span>
                  <input
                    type="number" min={0} step={0.1} className="edit-modal-input"
                    value={t.cueStartSec}
                    onChange={(e) => updateTrack(t.id, { cueStartSec: Number(e.target.value) })}
                  />
                </label>
                <label className="edit-modal-field half">
                  <span className="edit-modal-label">Playtime (s)</span>
                  <input
                    type="number" min={10} className="edit-modal-input"
                    value={t.targetPlaytimeSec}
                    onChange={(e) => updateTrack(t.id, { targetPlaytimeSec: Number(e.target.value) })}
                  />
                </label>
                <label className="edit-modal-field half">
                  <span className="edit-modal-label">Fade (s)</span>
                  <input
                    type="number" min={1} max={10} className="edit-modal-input"
                    value={t.fadeOutSec}
                    onChange={(e) => updateTrack(t.id, { fadeOutSec: Number(e.target.value) })}
                  />
                </label>
              </div>
              <button type="button" className="edit-modal-close cta" onClick={() => setEditingTrackId(null)}>
                Done
              </button>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

export default App

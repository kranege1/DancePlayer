import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  DANCES,
  WDSF_2025_DEFAULT_PLAYTIMES,
  type AppSettings,
  type BreakItem,
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

  const [fileMap, setFileMap] = useState<Record<string, File | undefined>>({})
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<string>>(new Set())
  const [libraryFilter, setLibraryFilter] = useState<DanceType | 'All'>('All')
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null)
  const [manualBreakSec, setManualBreakSec] = useState(50)
  const [manualBreakMode, setManualBreakMode] = useState<BreakItem['mode']>('countdown')
  const [dancePlaylists, setDancePlaylists] = useState<Playlist[]>([])
  const [activeTab, setActiveTab] = useState<'songs' | 'playlists' | 'player' | 'export'>('songs')

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  // Tracks whether the user *intends* listening to stay on — used for safe auto-restart on iOS
  const intendedListeningRef = useRef(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const activeObjectUrlRef = useRef<string | null>(null)
  const breakTimeoutRef = useRef<number | null>(null)
  const fadeFrameRef = useRef<number | null>(null)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as PersistedState
      setTracks(parsed.tracks ?? [])
      setPlaylist(parsed.playlist ?? initialPlaylist)
      setDancePlaylists(parsed.dancePlaylists ?? [])
      setSettings(parsed.settings ?? initialSettings)
      setSessionRule(parsed.sessionRule ?? initialSessionRule)
      setStatus('Metadata restored. Cached audio will load on demand from device storage.')
    } catch {
      setStatus('Could not restore saved metadata.')
    }
  }, [])

  useEffect(() => {
    const payload: PersistedState = { tracks, playlist, dancePlaylists, settings, sessionRule }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  }, [tracks, playlist, dancePlaylists, settings, sessionRule])

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
    const base = libraryFilter === 'All' ? tracks : tracks.filter((t) => t.danceType === libraryFilter)
    // Hide tracks already distributed — Songs tab is a staging area for new imports only
    return base.filter((t) => !distributedTrackIds.has(t.id))
  }, [tracks, libraryFilter, distributedTrackIds])

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

    setImportProgress({ done: 0, total: accepted.length })

    const imported: Track[] = []
    const importedMap: Record<string, File | undefined> = {}

    for (let i = 0; i < accepted.length; i++) {
      const file = accepted[i]
      setImportProgress({ done: i + 1, total: accepted.length })
      setStatus(`Analysing ${i + 1} of ${accepted.length}: ${file.name.replace(/\.[^.]+$/, '')}`)

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
        setStatus(`Checking online metadata ${i + 1} of ${accepted.length}: ${parsedTitle}`)
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
    setStatus(
      lowConfidenceCount > 0
        ? `Imported ${imported.length} track(s). ${lowConfidenceCount} need review in the list.`
        : `Imported ${imported.length} track(s). Dance type auto-detected from file names.`,
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

  function distributeToDancePlaylists() {
    if (!tracks.length) return
    const byDance: Partial<Record<DanceType, Track[]>> = {}
    for (const track of tracks) {
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
    setStatus(`Distributed ${tracks.length} track(s) into ${count} dance playlist(s) (no duplicates added).`)
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

  function addManualBreak() {
    const breakItem: BreakItem = {
      id: createId('break'),
      mode: manualBreakMode,
      durationSec: Math.max(5, Math.min(50, manualBreakSec)),
      label: `Manual ${manualBreakMode} break`,
    }
    setPlaylist((prev) => ({
      ...prev,
      entries: [...prev.entries, { id: createId('entry-break'), type: 'break', breakItem }],
    }))
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

  function speak(text: string) {
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = settings.language === 'de' ? 'de-DE' : 'en-US'
    window.speechSynthesis.speak(utterance)
  }

  function clearPlaybackTimers() {
    if (breakTimeoutRef.current) {
      window.clearTimeout(breakTimeoutRef.current)
      breakTimeoutRef.current = null
    }
    if (fadeFrameRef.current) {
      cancelAnimationFrame(fadeFrameRef.current)
      fadeFrameRef.current = null
    }
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
      setStatus(`Break: ${entry.breakItem.durationSec}s (${entry.breakItem.mode})`)
      if (entry.breakItem.mode === 'countdown') {
        const step = 10
        for (let t = entry.breakItem.durationSec; t >= 0; t -= step) {
          const delay = (entry.breakItem.durationSec - t) * 1000
          window.setTimeout(() => {
            if (t === 0 || t === 5 || t % 10 === 0) {
              speak(String(t))
            }
          }, delay)
        }
      }
      breakTimeoutRef.current = window.setTimeout(() => {
        void playEntryByIndex(index + 1)
      }, entry.breakItem.durationSec * 1000)
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
      speak(phrase)
      setRepeatAnnounce(phrase)
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
            void playEntryByIndex(index + 1)
            return
          }
          fadeFrameRef.current = requestAnimationFrame(tick)
        }

        fadeFrameRef.current = requestAnimationFrame(tick)
      }
    }

    audio.onended = () => {
      void playEntryByIndex(index + 1)
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
          <label className="file-label" htmlFor="music-files">
            Import mp3 / wav / aac / m4a / aiff
          </label>
          <input id="music-files" type="file" multiple accept=".mp3,.wav,.aac,.m4a,.aiff" onChange={handleImport} />

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
              <select
                value={libraryFilter}
                onChange={(e) => setLibraryFilter(e.target.value as DanceType | 'All')}
              >
                <option value="All">All dances</option>
                {DANCES.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <button type="button" onClick={selectAllFiltered}>
                Select all ({visibleTracks.length})
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
                  Distribute to dance playlists
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
          <div className="playlist-topbar">
            <h2>Playlist</h2>
            <button type="button" onClick={createNewPlaylist}>
              New playlist
            </button>
          </div>

          <label className="playlist-name-field">
            Playlist name
            <input value={playlist.name} onChange={(e) => renameCurrentPlaylist(e.target.value)} />
          </label>

          <p className="playlist-hint">Use the Dance Playlists below to build your queue.</p>
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

          {/* Break inserter — in Player so you can drop a break into the live queue */}
          <h3>Insert break</h3>
          <div className="row compact">
            <label>
              Duration (s)
              <input
                type="number"
                min={5}
                max={300}
                value={manualBreakSec}
                onChange={(e) => setManualBreakSec(Number(e.target.value))}
              />
            </label>
            <label>
              Mode
              <select
                value={manualBreakMode}
                onChange={(e) => setManualBreakMode(e.target.value as BreakItem['mode'])}
              >
                <option value="silence">Silence</option>
                <option value="countdown">Countdown</option>
                <option value="applause">Applause</option>
              </select>
            </label>
            <button type="button" onClick={addManualBreak}>
              Add Break
            </button>
          </div>

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
              disabled={!window.isSecureContext}
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
                        <span className="pq-title">{cleanDisplayTitle(t.title)}</span>
                        {t.artist && <span className="pq-artist">{t.artist}</span>}
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
                          <button
                            type="button"
                            className="add-one-btn"
                            title="Add to queue"
                            onClick={(e) => {
                              e.stopPropagation()
                              setPlaylist((prev) => ({
                                ...prev,
                                entries: [...prev.entries, { id: createId('entry-track'), type: 'track' as const, trackId: entry.trackId }],
                              }))
                              setStatus(`Added \u201c${t.title}\u201d to playlist.`)
                            }}
                          >+</button>
                          <button
                            type="button"
                            className="remove-dance-track-btn"
                            title="Remove from dance playlist"
                            onClick={(e) => {
                              e.stopPropagation()
                              setDancePlaylists((prev) => prev.map((p) =>
                                p.id === dp.id
                                  ? { ...p, entries: p.entries.filter((en) => en.id !== entry.id) }
                                  : p
                              ))
                              setStatus(`Removed \u201c${t.title}\u201d from ${dp.name}.`)
                            }}
                          >✕</button>
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

import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import * as mm from 'music-metadata-browser'
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
import { clearAllAudioFiles, getAudioFile, saveAudioFile, removeAudioFile } from './mediaStore'
import { parseVoiceIntent } from './voice'
import { analyzeTrackRhythm } from './analysis'
import { getFadeWindow, getRepeatThirtyStart } from './playbackMath'
import { lookupTrackOnMusicBrainz } from './musicbrainz'
import { parseFilenamesWithGrok, type GrokTrackInfo } from './grok'
import danceShapeUrl from './DanceShape.png'

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
const REMOVED_TRACKS_KEY = 'danceplayer-removed-tracks-v1'

interface RemovedTrackRecord {
  hash?: string
  filename?: string
  title?: string
}

function markTrackAsRemoved(hash?: string, filename?: string, title?: string) {
  try {
    const raw = localStorage.getItem(REMOVED_TRACKS_KEY)
    const list: RemovedTrackRecord[] = raw ? JSON.parse(raw) : []
    const alreadyExists = list.some(item => 
      (hash && item.hash === hash) ||
      (filename && item.filename === filename) ||
      (title && item.title === title)
    )
    if (!alreadyExists) {
      list.push({ hash, filename, title })
      localStorage.setItem(REMOVED_TRACKS_KEY, JSON.stringify(list))
    }
  } catch (err) {
    console.error('Failed to mark track as removed in localStorage:', err)
  }
}

interface PersistedState {
  tracks: Track[]
  playlist: Playlist
  dancePlaylists: Playlist[]
  savedPlaylists: Playlist[]
  settings: AppSettings
  sessionRule: SessionRule
  dancePlaylistSorts?: Record<string, 'name' | 'stars'>
}

const initialSettings: AppSettings = {
  speedPct: 0,
  wdsfTimedMode: false,
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
  announcementEnabled: false,
}

function createId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

function clampSpeed(value: number) {
  const rounded = Math.round(value / 10) * 10
  return Math.max(-50, Math.min(50, rounded))
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
  Other: '#546e7a',
}

const DANCE_ABBR: Record<DanceType, string> = {
  Samba: 'SA',
  ChaCha: 'CC',
  Rumba: 'RB',
  'Paso Doble': 'PD',
  Jive: 'JV',
  Waltz: 'SW',
  Tango: 'TG',
  'Viennese Waltz': 'VW',
  Foxtrot: 'SF',
  Quickstep: 'QS',
  Other: 'OTH',
}

// Strip leading track-number prefixes and trailing dance/BPM annotations
function cleanDisplayTitle(raw: string): string {
  let s = raw.trim()
  s = s.replace(/^(\d{1,3}\.?\s*[-\u2013]?\s+|Track\s+\d+\s*[-\u2013]?\s*)/i, '')
  s = s.replace(/[\s-\u2013]+[([]?(?:[A-Z][a-z]{0,3}\s+\d+|\d+\s*BPM|BPM\s*\d+)[)\]]?$/i, '')
  // Also strip inline dance/BPM annotations anywhere in the title, e.g. " (Sb 51)" or "(Ch 32)"
  s = s.replace(/\s*[([][A-Z][a-z]{0,3}\s+\d+[)\]]/g, '')
  s = s.replace(/_/g, ' ').trim()
  return s || raw
}

function cleanStoredTitle(raw: string): string {
  return cleanDisplayTitle(raw)
}

// Try to extract "Artist - Title" from a bare filename (no extension)
function extractArtistFromFilename(filenameNoExt: string): { title: string; artist?: string; danceHint?: string } {
  let name = filenameNoExt.trim()
  let danceHint: string | undefined

  // Strip leading (Dance, ...) or [Dance] prefix — e.g. "(Samba, brasilianisch) Desi Arnez - Tico Tico"
  const parenPrefixMatch = name.match(/^[([{]([^)\]{}]+)[)\]{}]\s*/)
  if (parenPrefixMatch) {
    danceHint = parenPrefixMatch[1].trim()
    name = name.slice(parenPrefixMatch[0].length).trim()
  }

  const dashMatch = name.match(/^(.+?)\s*[-\u2013]\s*(.+)$/)
  if (dashMatch) {
    const left = dashMatch[1].trim()
    const right = dashMatch[2].trim()
    const looksLikeDance = /\b(waltz|tango|samba|cha|rumba|paso|jive|foxtrot|quickstep|viennese)\b/i.test(left)
    if (!looksLikeDance && left.length > 1 && right.length > 1) {
      if (!danceHint) {
        const leftIsDance = /\b(waltz|tango|samba|cha|rumba|paso|jive|foxtrot|quickstep|viennese)\b/i.test(left)
        if (leftIsDance) {
          danceHint = left
          return { title: right, danceHint }
        }
      }
      return { title: right, artist: left, danceHint }
    }
    if (!danceHint) danceHint = left
    return { title: right, danceHint }
  }

  return { title: name, danceHint }
}

export async function computeFileHash(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer()
  const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
  return hashHex
}

function formatTime(s: number): string {
  const mins = Math.floor(Math.max(0, s) / 60)
  const secs = Math.floor(Math.max(0, s) % 60)
  return `${mins}:${String(secs).padStart(2, '0')}`
}

function App() {
  // Load initial persisted state synchronously from localStorage to avoid setting state in useEffect
  const persistedState = useMemo((): Partial<PersistedState> => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        return JSON.parse(raw) as PersistedState
      }
    } catch {
      // ignore
    }
    return {}
  }, [])

  const [tracks, setTracks] = useState<Track[]>(() => {
    let loaded = persistedState.tracks ?? []
    const migratedKey = 'danceplayer-migrated-ratings-to-zero-v1'
    if (!localStorage.getItem(migratedKey)) {
      loaded = loaded.map((t) => ({ ...t, qualityRating: 0, rhythmRating: 0 }))
      localStorage.setItem(migratedKey, 'true')
    }
    return loaded
  })
  const [playlist, setPlaylist] = useState<Playlist>(() => persistedState.playlist ?? initialPlaylist)
  const [settings, setSettings] = useState<AppSettings>(() => persistedState.settings ?? initialSettings)
  const [sessionRule, setSessionRule] = useState<SessionRule>(() => persistedState.sessionRule ?? initialSessionRule)
  const [status, setStatus] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return raw ? 'Metadata restored. Cached audio will load on demand from device storage.' : 'Ready'
    } catch {
      return 'Could not restore saved metadata.'
    }
  })
  const [isListening, setIsListening] = useState(false)
  const [dancePlaylistSorts, setDancePlaylistSorts] = useState<Record<string, 'name' | 'stars'>>(() => persistedState.dancePlaylistSorts ?? {})
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null)
  const [repeatAnnounce, setRepeatAnnounce] = useState('')
  const [breakSecondsLeft, setBreakSecondsLeft] = useState<number | null>(null)
  const [breakInfo, setBreakInfo] = useState<{ mode: SessionRule['breakMode']; totalSec: number } | null>(null)
  const [trackProgress, setTrackProgress] = useState(0) // 0–1
  const [previewingTrackId, setPreviewingTrackId] = useState<string | null>(null)
  const [previewCurrentTime, setPreviewCurrentTime] = useState(0)
  const [previewDuration, setPreviewDuration] = useState(0)
  const [mainCurrentTime, setMainCurrentTime] = useState(0)
  const [mainDuration, setMainDuration] = useState(0)
  const [openDanceCards, setOpenDanceCards] = useState<Set<string>>(new Set())

  const [fileMap, setFileMap] = useState<Record<string, File | undefined>>({})
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<string>>(new Set())

  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null)
  const [dancePlaylists, setDancePlaylists] = useState<Playlist[]>(() => persistedState.dancePlaylists ?? [])
  const [savedPlaylists, setSavedPlaylists] = useState<Playlist[]>(() => persistedState.savedPlaylists ?? [])
  const [activeTab, setActiveTab] = useState<'songs' | 'playlists' | 'player' | 'export'>('songs')
  const [editingTrackId, setEditingTrackId] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  // Tracks whether the user *intends* listening to stay on — used for safe auto-restart on iOS
  const intendedListeningRef = useRef(false)
  const sessionRuleRef = useRef<SessionRule>(initialSessionRule)
  sessionRuleRef.current = sessionRule
  const settingsRef = useRef<AppSettings>(settings)
  settingsRef.current = settings
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const previewAudioRef = useRef<HTMLAudioElement>(new Audio())
  const previewObjectUrlRef = useRef<string | null>(null)
  const activeObjectUrlRef = useRef<string | null>(null)
  const breakTimeoutRef = useRef<number | null>(null)
  const breakTickRef = useRef<number | null>(null)
  const breakAudioCtxRef = useRef<AudioContext | null>(null)
  const applauseAudioRefs = useRef<HTMLAudioElement[]>([])
  const applauseTimeoutRef = useRef<number | null>(null)
  // Persistent AudioContext + decoded buffer — created once on first user gesture, reused for all applause
  const sharedAudioCtxRef = useRef<AudioContext | null>(null)
  const applauseBufferRef = useRef<AudioBuffer | null>(null)
  const trackProgressRef = useRef<number | null>(null)
  const fadeFrameRef = useRef<number | null>(null)

  useEffect(() => {
    const payload: PersistedState = { tracks, playlist, dancePlaylists, savedPlaylists, settings, sessionRule, dancePlaylistSorts }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
    sessionRuleRef.current = sessionRule
  }, [tracks, playlist, dancePlaylists, savedPlaylists, settings, sessionRule, dancePlaylistSorts])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.playbackRate = 1 + settings.speedPct / 100
  }, [settings.speedPct])

  useEffect(() => {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().then((persistent) => {
        if (persistent) {
          console.log('Storage persistence guaranteed by browser.')
        } else {
          console.warn('Storage persistence denied by browser.')
        }
      }).catch((err) => {
        console.error('Error requesting storage persistence:', err)
      })
    }
  }, [])

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

  useEffect(() => {
    const pa = previewAudioRef.current
    const handleTimeUpdate = () => {
      setPreviewCurrentTime(pa.currentTime)
      setPreviewDuration(pa.duration || 0)
    }
    const handleEnded = () => {
      setPreviewingTrackId(null)
      setPreviewCurrentTime(0)
      setPreviewDuration(0)
    }
    pa.addEventListener('timeupdate', handleTimeUpdate)
    pa.addEventListener('ended', handleEnded)
    return () => {
      pa.removeEventListener('timeupdate', handleTimeUpdate)
      pa.removeEventListener('ended', handleEnded)
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

  function deleteSelectedTracks() {
    if (!selectedTrackIds.size) return

    // Stop preview if the previewing track is being deleted
    if (previewingTrackId && selectedTrackIds.has(previewingTrackId)) {
      const pa = previewAudioRef.current
      if (!pa.paused) {
        pa.pause()
        if (previewObjectUrlRef.current) {
          URL.revokeObjectURL(previewObjectUrlRef.current)
          previewObjectUrlRef.current = null
        }
        setPreviewingTrackId(null)
      }
    }

    const idsToDelete = Array.from(selectedTrackIds)
    // Record deleted tracks in history
    tracks.forEach((t) => {
      if (selectedTrackIds.has(t.id)) {
        markTrackAsRemoved(t.hash, t.filename, t.title)
      }
    })

    setTracks((prev) => prev.filter((t) => !selectedTrackIds.has(t.id)))
    idsToDelete.forEach((id) => {
      void removeAudioFile(id)
    })
    setFileMap((prev) => {
      const next = { ...prev }
      idsToDelete.forEach((id) => {
        delete next[id]
      })
      return next
    })
    clearSelection()
    setStatus(`Deleted ${idsToDelete.length} track(s) from staging library and device storage.`)
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

    // Compute hashes for all accepted files to check for duplicates
    setStatus('Checking for duplicate files...')
    const fileHashes = await Promise.all(accepted.map(async (file) => {
      try {
        const hash = await computeFileHash(file)
        return { file, hash }
      } catch (err) {
        console.error('Failed to compute hash for file:', file.name, err)
        return { file, hash: undefined }
      }
    }))

    const newFiles = fileHashes.filter(({ file, hash }) => {
      const isDuplicate = tracks.some((t) => {
        if (hash && t.hash) {
          return t.hash === hash
        }
        const nameNoExt = file.name.replace(/\.[^.]+$/, '').trim().toLowerCase()
        return t.title.trim().toLowerCase() === nameNoExt
      })
      return !isDuplicate
    })

    const skippedCount = accepted.length - newFiles.length
    if (!newFiles.length) {
      setStatus(`All ${accepted.length} file(s) already imported (detected by hash/name).`)
      event.target.value = ''
      return
    }
    const filesToImport = newFiles.map(nf => nf.file)
    const filesToImportHashes = newFiles.map(nf => nf.hash)

    setImportProgress({ done: 0, total: filesToImport.length })

    // ── Grok batch parse (one API call for all files) ────────────────────────
    let grokResults: (GrokTrackInfo | null)[] = filesToImport.map(() => null)
    if (settings.grokApiKey && navigator.onLine) {
      try {
        setStatus(`🤖 Asking Grok to identify ${filesToImport.length} file(s)…`)
        grokResults = await parseFilenamesWithGrok(
          filesToImport.map((f) => f.name.replace(/\.[^.]+$/, '')),
          settings.grokApiKey,
        )
        console.log('🤖 Grok batch results:', grokResults)
      } catch (err) {
        console.warn('Grok batch parse failed, falling back to local analysis:', err)
      }
    }

    const imported: Track[] = []
    const importedMap: Record<string, File | undefined> = {}

    let removedList: RemovedTrackRecord[] = []
    try {
      const raw = localStorage.getItem(REMOVED_TRACKS_KEY)
      if (raw) removedList = JSON.parse(raw)
    } catch (e) {
      console.error(e)
    }

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
      const { title: regexTitle, artist: regexArtist, danceHint: regexDanceHint } = extractArtistFromFilename(rawName)

      // Merge Grok result (if available) with regex result — Grok wins on title/artist/dance
      const grok = grokResults[i]
      const parsedTitle = grok?.title ?? regexTitle
      const parsedArtist = grok?.artist ?? regexArtist
      const danceHint = grok?.danceType ?? regexDanceHint

      // Step 1: quick local analysis from filename
      const localAnalysis = await analyzeTrackRhythm(file, {
        title: rawName,
        fileName: file.name,
        danceHint,
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
              danceHint,
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
      const fileHash = filesToImportHashes[i]
      const wasRemovedEarlier = removedList.some(item => 
        (fileHash && item.hash === fileHash) ||
        (item.filename && item.filename === file.name) ||
        (item.title && item.title === finalTitle)
      )

      let initialRating = 0
      try {
        const metadata = await mm.parseBlob(file)
        const ratings = metadata.common.rating
        if (ratings && ratings.length > 0) {
          initialRating = Math.round(ratings[0].rating * 5)
        }
      } catch (err) {
        console.warn('Failed to parse audio tags for rating:', err)
      }

      imported.push({
        id,
        title: finalTitle,
        artist: finalArtist,
        filename: file.name,
        danceType,
        analysisConfidence: finalConfidence,
        hasCachedAudio: true,
        qualityRating: initialRating,
        rhythmRating: 0,
        durationSec,
        cueStartSec: 0,
        targetPlaytimeSec: WDSF_2025_DEFAULT_PLAYTIMES[danceType],
        fadeOutSec: 3,
        hash: fileHash,
        removedEarlier: wasRemovedEarlier,
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
    // Allow empty while typing — trim only matters at save time
    setPlaylist((prev) => ({ ...prev, name: nextName }))
  }

  function removePlaylistEntry(entryId: string) {
    setPlaylist((prev) => ({ ...prev, entries: prev.entries.filter((e) => e.id !== entryId) }))
  }

  function moveCurrentEntry(fromIndex: number, dir: -1 | 1) {
    const toIndex = fromIndex + dir
    setPlaylist((prev) => {
      if (toIndex < 0 || toIndex >= prev.entries.length) return prev
      const entries = [...prev.entries]
      ;[entries[fromIndex], entries[toIndex]] = [entries[toIndex], entries[fromIndex]]
      return { ...prev, entries }
    })
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
    const toSave = { ...playlist, name: playlist.name.trim() }
    setSavedPlaylists((prev) => {
      const exists = prev.findIndex((p) => p.id === toSave.id)
      if (exists >= 0) {
        const next = [...prev]
        next[exists] = toSave
        return next
      }
      return [...prev, toSave]
    })
    // Reset the working playlist so it's ready for a new one
    setPlaylist({ ...initialPlaylist, id: crypto.randomUUID() })
    setActiveEntryId(null)
    setStatus(`Playlist "${toSave.name}" saved.`)
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

  function downloadRatingEditor() {
    const a = document.createElement('a')
    a.href = '/rating_editor.py'
    a.download = 'rating_editor.py'
    a.click()
    setStatus('Downloaded rating_editor.py helper tool.')
  }

  function downloadRatingEditorExe() {
    const a = document.createElement('a')
    a.href = '/DancePlayer-RatingEditor.exe'
    a.download = 'DancePlayer-RatingEditor.exe'
    a.click()
    setStatus('Downloaded DancePlayer-RatingEditor.exe helper executable.')
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
      const timesToSpeak = [0]
      if (dur >= 5) timesToSpeak.push(5)
      for (let s = 10; s <= dur; s += 10) {
        if (!timesToSpeak.includes(s)) timesToSpeak.push(s)
      }
      timesToSpeak.forEach((t) => {
        window.setTimeout(() => { speak(String(t)) }, (dur - t) * 1000)
      })
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



  /** Ensure a shared AudioContext exists and is resumed (must be called inside a user gesture). */
  function ensureAudioCtx() {
    if (!sharedAudioCtxRef.current) {
      try { sharedAudioCtxRef.current = new AudioContext() } catch { return }
    }
    if (sharedAudioCtxRef.current.state === 'suspended') {
      void sharedAudioCtxRef.current.resume()
    }
  }

  /** Pre-fetch and decode Applause.mp3 into the shared AudioContext buffer. */
  async function ensureApplauseBuffer() {
    if (applauseBufferRef.current) return
    const ctx = sharedAudioCtxRef.current
    if (!ctx) return
    try {
      const resp = await fetch('/Applause.mp3')
      const arrayBuf = await resp.arrayBuffer()
      applauseBufferRef.current = await ctx.decodeAudioData(arrayBuf)
    } catch { /* fetch/decode failed */ }
  }

  /** Play the decoded applause buffer once through the shared AudioContext. */
  function playApplauseBurst() {
    const ctx = sharedAudioCtxRef.current
    const buf = applauseBufferRef.current
    if (!ctx || !buf) return
    if (ctx.state === 'suspended') void ctx.resume()
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    src.start()
  }

  /** Plays Applause.mp3 (play → wait durationSec → play again) or a silent keep-alive for the break. */
  function startBreakAudio(mode: 'applause' | 'silence' | 'countdown', durationSec: number) {
    // Stop any leftover applause from a previous break
    applauseAudioRefs.current.forEach((a) => { a.pause(); a.src = '' })
    applauseAudioRefs.current = []
    if (breakAudioCtxRef.current) { void breakAudioCtxRef.current.close(); breakAudioCtxRef.current = null }
    if (mode !== 'applause' && mode !== 'silence') return

    if (mode === 'silence') {
      // Near-zero WebAudio buffer keeps the iOS audio session alive without audible sound
      const ctx = sharedAudioCtxRef.current
      if (ctx) {
        if (ctx.state === 'suspended') void ctx.resume()
        const sr = ctx.sampleRate
        const loopBuf = ctx.createBuffer(1, Math.ceil(sr * 2), sr)
        const src = ctx.createBufferSource()
        src.buffer = loopBuf; src.loop = true
        const g = ctx.createGain(); g.gain.value = 0.0001
        src.connect(g); g.connect(ctx.destination)
        src.start(); src.stop(ctx.currentTime + durationSec)
      }
      return
    }

    // ── Applause: first burst immediately, second 3 seconds before break ends ──
    // Uses the shared AudioContext (already unlocked by user gesture) — works on iOS.
    playApplauseBurst()
    const delay = Math.max(0, (durationSec - 3) * 1000)
    applauseTimeoutRef.current = window.setTimeout(() => {
      playApplauseBurst()
      applauseTimeoutRef.current = null
    }, delay)
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
    if (applauseTimeoutRef.current) {
      window.clearTimeout(applauseTimeoutRef.current)
      applauseTimeoutRef.current = null
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
        const timesToSpeak = [0]
        if (dur >= 5) timesToSpeak.push(5)
        for (let s = 10; s <= dur; s += 10) {
          if (!timesToSpeak.includes(s)) timesToSpeak.push(s)
        }
        timesToSpeak.forEach((t) => {
          const delay = (dur - t) * 1000
          window.setTimeout(() => { speak(String(t)) }, delay)
        })
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

    if (sessionRuleRef.current.announcementEnabled) {
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
    audio.playbackRate = 1 + settingsRef.current.speedPct / 100

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

      if (settingsRef.current.wdsfTimedMode) {
        const fadeWindow = getFadeWindow(startSec, track.targetPlaytimeSec, 5) // always 5 s fade in timed mode

        const tick = () => {
          if (!audio || audio.ended) return
          // Keep rescheduling even while buffering/paused — do NOT bail out on paused
          if (!audio.paused) {
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

  function togglePlayPause() {
    const audio = audioRef.current
    if (!audio) return
    ensureAudioCtx()
    void ensureApplauseBuffer()
    if (audio.src && audio.src !== '' && !audio.src.endsWith('/')) {
      if (audio.paused) {
        void audio.play().catch(() => null)
      } else {
        audio.pause()
      }
    } else {
      playFromStart()
    }
  }

  function playFromStart() {
    if (!playableEntries.length) {
      setStatus('No playlist entries to play.')
      return
    }
    // Initialize & unlock AudioContext on user gesture so applause works on iOS
    ensureAudioCtx()
    void ensureApplauseBuffer()
    void playEntryByIndex(0)
  }

  function nextSong() {
    if (currentIndex < 0) {
      playFromStart()
      return
    }
    const rule = sessionRuleRef.current
    if (currentTrack && !breakInfo && rule.autoBreakEnabled) {
      runBreakThenAdvance(currentIndex + 1, rule)
    } else {
      void playEntryByIndex(currentIndex + 1)
    }
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
      <header className="hero" style={{ display: 'flex', alignItems: 'center', gap: '20px', flexWrap: 'wrap' }}>
        <img src={danceShapeUrl} alt="Dance Shape" style={{ height: '75px', width: 'auto', borderRadius: '12px', filter: 'drop-shadow(0 4px 6px rgba(0,0,0,0.3))' }} />
        <div style={{ flex: 1, minWidth: '200px' }}>
          <p className="kicker">DancePlayer PWA</p>
          <h1 style={{ margin: '4px 0 8px' }}>Dance Player</h1>
          <p className="subtitle">
            Local-first dance playback with smart breaks, pitch control and voice commands.
          </p>
        </div>
        <div className="status-row" style={{ width: '100%', margin: '8px 0 0' }}>
          <span className="status-pill">{status}</span>
        </div>
      </header>

      <main className="tab-content">
        {/* ── Songs ── */}
        {activeTab === 'songs' && (
        <section className="panel">
          <h2>Library</h2>
          <label className="file-label" htmlFor="music-files">Import music</label>
          <input id="music-files" type="file" multiple onChange={handleImport} style={{ display: 'none' }} {...{ webkitdirectory: '', mozdirectory: '' } as React.InputHTMLAttributes<HTMLInputElement>} />

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
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', margin: '10px 0 6px' }}>
              <div className="lib-toolbar" style={{ margin: 0 }}>
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

              {selectedTrackIds.size > 0 && (
                <div className="selected-actions-toolbar" style={{ padding: '10px', background: 'rgba(255,255,255,0.05)', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)' }}>
                  <h4 style={{ margin: '0 0 8px 0', fontSize: '0.85rem', color: '#a0b2bd', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Selected ({selectedTrackIds.size}) Actions
                  </h4>
                  <div className="row compact" style={{ margin: 0, gap: '8px' }}>
                    <button
                      type="button"
                      onClick={() => {
                        let count = 0
                        setTracks((prev) => prev.map((tr) => {
                          if (selectedTrackIds.has(tr.id)) {
                            const cleaned = cleanStoredTitle(tr.title)
                            const artistCleaned = tr.artist && /^\d{1,3}$/.test(tr.artist.trim()) ? undefined : tr.artist
                            if (cleaned !== tr.title || artistCleaned !== tr.artist) { count++ }
                            return { ...tr, title: cleaned, artist: artistCleaned }
                          }
                          return tr
                        }))
                        setStatus(`Cleaned titles of ${count} selected track(s).`)
                      }}
                    >
                      ✦ Clean Titles
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!window.confirm(`Reset ratings of ${selectedTrackIds.size} selected song(s) to zero stars?`)) return
                        setTracks((prev) => prev.map((t) => {
                          if (selectedTrackIds.has(t.id)) {
                            return { ...t, qualityRating: 0, rhythmRating: 0 }
                          }
                          return t
                        }))
                        setStatus(`Reset ratings of ${selectedTrackIds.size} selected track(s).`)
                      }}
                    >
                      ☆ Reset Ratings
                    </button>
                    <button type="button" className="btn-danger" onClick={deleteSelectedTracks}>
                      🗑 Delete
                    </button>
                    <select
                      value=""
                      onChange={(e) => {
                        const targetDance = e.target.value as DanceType
                        if (!targetDance) return
                        setTracks((prev) =>
                          prev.map((t) =>
                            selectedTrackIds.has(t.id)
                              ? { ...t, danceType: targetDance, targetPlaytimeSec: WDSF_2025_DEFAULT_PLAYTIMES[targetDance] }
                              : t
                          )
                        )
                        setStatus(`Moved ${selectedTrackIds.size} selected track(s) to ${targetDance}.`)
                      }}
                      style={{ background: '#1c3d4e', color: '#fff9ef', borderColor: 'rgba(255, 255, 255, 0.2)' }}
                    >
                      <option value="" disabled>Move to Dance...</option>
                      {DANCES.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
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
                    {track.removedEarlier ? (
                      <span className="badge badge-warn" style={{ background: '#b71c1c', color: '#fff' }}>
                        Removed earlier
                      </span>
                    ) : (
                      <>
                        {track.analysisConfidence !== undefined && (
                          <span className={`badge ${track.analysisConfidence >= 0.7 ? 'badge-ok' : 'badge-warn'}`}>
                            {getConfidenceLabel(track.analysisConfidence)} {Math.round(track.analysisConfidence * 100)}%
                          </span>
                        )}
                        {isLowConfidenceTrack(track) && <span className="badge badge-review">Review</span>}
                      </>
                    )}
                    <button
                      type="button"
                      className={previewingTrackId === track.id ? 'live' : ''}
                      onClick={(e) => {
                        e.stopPropagation()
                        void togglePreview(track.id)
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '34px',
                        height: '34px',
                        minWidth: '34px',
                        padding: 0,
                        borderRadius: '50%',
                        cursor: 'pointer',
                        lineHeight: 1,
                        marginRight: '4px',
                      }}
                    >
                      {previewingTrackId === track.id ? '⏸' : '▶'}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        const pa = previewAudioRef.current
                        if (previewingTrackId === track.id && !pa.paused) {
                          pa.pause()
                          if (previewObjectUrlRef.current) {
                            URL.revokeObjectURL(previewObjectUrlRef.current)
                            previewObjectUrlRef.current = null
                          }
                          setPreviewingTrackId(null)
                        }
                        markTrackAsRemoved(track.hash, track.filename, track.title)
                        void removeAudioFile(track.id)
                        setTracks((prev) => prev.filter((x) => x.id !== track.id))
                        setFileMap((prev) => {
                          const next = { ...prev }
                          delete next[track.id]
                          return next
                        })
                        setPlaylist((prev) => ({
                          ...prev,
                          entries: prev.entries.filter((en) => en.type !== 'track' || en.trackId !== track.id)
                        }))
                        setDancePlaylists((prev) => prev.map((p) => ({
                          ...p,
                          entries: p.entries.filter((en) => en.type !== 'track' || en.trackId !== track.id)
                        })))
                        setSavedPlaylists((prev) => prev.map((p) => ({
                          ...p,
                          entries: p.entries.filter((en) => en.type !== 'track' || en.trackId !== track.id)
                        })))
                        setStatus(`Deleted "${track.title}" permanently.`)
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '34px',
                        height: '34px',
                        minWidth: '34px',
                        padding: 0,
                        borderRadius: '50%',
                        cursor: 'pointer',
                        lineHeight: 1,
                      }}
                      title="Delete track"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ff5252" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                      </svg>
                    </button>
                  </span>
                </div>
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
          </div>

          {/* ── Current working playlist entries ── */}
          {playlist.entries.length > 0 && (
            <div className="current-playlist-entries">
              {playlist.entries.map((entry, idx) => {
                if (entry.type === 'break') return (
                  <div key={entry.id} className="qe-row qe-break">
                    <span className="qe-num">{idx + 1}</span>
                    <span className="qe-label">⏸ Break {entry.breakItem.durationSec}s</span>
                    <div className="qe-actions">
                      <button type="button" onClick={() => moveCurrentEntry(idx, -1)} disabled={idx === 0} aria-label="Move up">↑</button>
                      <button type="button" onClick={() => moveCurrentEntry(idx, 1)} disabled={idx === playlist.entries.length - 1} aria-label="Move down">↓</button>
                      <button type="button" className="remove-btn" onClick={() => removePlaylistEntry(entry.id)} aria-label="Remove">✕</button>
                    </div>
                  </div>
                )
                const t = tracksById[entry.trackId]
                if (!t) return (
                  <div key={entry.id} className="qe-row qe-missing">
                    <span className="qe-num">{idx + 1}</span>
                    <span className="qe-label">Missing track</span>
                    <div className="qe-actions">
                      <button type="button" className="remove-btn" onClick={() => removePlaylistEntry(entry.id)}>✕</button>
                    </div>
                  </div>
                )
                return (
                  <div key={entry.id} className="qe-row">
                    <span className="qe-num">{idx + 1}</span>
                    <span className="dance-badge qe-badge" style={{ background: DANCE_COLORS[t.danceType] }} title={t.danceType}>{DANCE_ABBR[t.danceType]}</span>
                    <span className="qe-info" style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span className="qe-title">{cleanDisplayTitle(t.title)}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <div style={{ display: 'inline-flex', gap: '0px', fontSize: '0.8rem', userSelect: 'none', lineHeight: 1 }} onClick={(e) => e.stopPropagation()}>
                          {[1, 2, 3, 4, 5].map((star) => {
                            const isFilled = star <= (t.qualityRating ?? 0)
                            return (
                              <span
                                key={star}
                                onClick={() => {
                                  const newRating = t.qualityRating === star ? 0 : star
                                  updateTrack(t.id, { qualityRating: newRating })
                                }}
                                style={{
                                  cursor: 'pointer',
                                  color: isFilled ? 'var(--sun)' : 'rgba(232, 159, 62, 0.22)',
                                  padding: '0 1px',
                                  display: 'inline-block',
                                }}
                                title={isFilled ? `Remove star ${star}` : `Rate ${star} star${star > 1 ? 's' : ''}`}
                              >
                                ★
                              </span>
                            )
                          })}
                        </div>
                        {t.artist && <span className="qe-artist" style={{ margin: 0 }}>{t.artist}</span>}
                      </div>
                    </span>
                    <div className="qe-actions">
                      <button type="button" onClick={() => moveCurrentEntry(idx, -1)} disabled={idx === 0} aria-label="Move up">↑</button>
                      <button type="button" onClick={() => moveCurrentEntry(idx, 1)} disabled={idx === playlist.entries.length - 1} aria-label="Move down">↓</button>
                      <button type="button" className="remove-btn" onClick={() => removePlaylistEntry(entry.id)} aria-label="Remove">✕</button>
                    </div>
                  </div>
                )
              })}
              <p className="hint" style={{ margin: '6px 0 0' }}>
                {playlist.entries.filter(e => e.type === 'track').length} track(s) — click <strong>Save</strong> to store and clear
              </p>
            </div>
          )}

          {/* ── Saved playlists ── */}
          {savedPlaylists.length > 0 && (
            <>
              <h3 className="saved-playlists-heading">My Playlists</h3>
              <div className="saved-playlists-list">
                {savedPlaylists.map((sp) => (
                  <details key={sp.id} className="saved-playlist-item">
                    <summary className="saved-playlist-summary">
                      <input
                        type="text"
                        className="saved-playlist-name"
                        value={sp.name}
                        onClick={(e) => e.stopPropagation()}
                        onMouseDown={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === ' ' || e.key === 'Enter') {
                            e.stopPropagation()
                            if (e.key === 'Enter') {
                              e.currentTarget.blur()
                            }
                          }
                        }}
                        onChange={(e) => {
                          const nextName = e.target.value
                          setSavedPlaylists((prev) =>
                            prev.map((p) => (p.id === sp.id ? { ...p, name: nextName } : p))
                          )
                        }}
                      />
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
                            <span className="dance-badge qe-badge" style={{ background: DANCE_COLORS[t.danceType] }} title={t.danceType}>{DANCE_ABBR[t.danceType]}</span>
                            <span className="qe-info" style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                              <span className="qe-title">{cleanDisplayTitle(t.title)}</span>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <div style={{ display: 'inline-flex', gap: '0px', fontSize: '0.8rem', userSelect: 'none', lineHeight: 1 }} onClick={(e) => e.stopPropagation()}>
                                  {[1, 2, 3, 4, 5].map((star) => {
                                    const isFilled = star <= (t.qualityRating ?? 0)
                                    return (
                                      <span
                                        key={star}
                                        onClick={() => {
                                          const newRating = t.qualityRating === star ? 0 : star
                                          updateTrack(t.id, { qualityRating: newRating })
                                        }}
                                        style={{
                                          cursor: 'pointer',
                                          color: isFilled ? 'var(--sun)' : 'rgba(232, 159, 62, 0.22)',
                                          padding: '0 1px',
                                          display: 'inline-block',
                                        }}
                                        title={isFilled ? `Remove star ${star}` : `Rate ${star} star${star > 1 ? 's' : ''}`}
                                      >
                                        ★
                                      </span>
                                    )
                                  })}
                                </div>
                                {t.artist && <span className="qe-artist" style={{ margin: 0 }}>{t.artist}</span>}
                              </div>
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

          {/* Playlist pickers: dance dances + other playlists */}
          <div className="player-playlist-pickers">
            <select
              value={dancePlaylists.some((p) => p.id === playlist.id) ? playlist.id : ''}
              onChange={(e) => {
                const found = dancePlaylists.find((p) => p.id === e.target.value)
                if (found) loadSavedPlaylist(found)
              }}
              disabled={dancePlaylists.length === 0}
            >
              <option value="">Dance…</option>
              {dancePlaylists.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {(() => {
              const custom = savedPlaylists.filter((sp) => !dancePlaylists.some((dp) => dp.id === sp.id))
              return (
                <select
                  value={custom.some((p) => p.id === playlist.id) ? playlist.id : ''}
                  onChange={(e) => {
                    const found = custom.find((p) => p.id === e.target.value)
                    if (found) loadSavedPlaylist(found)
                  }}
                  disabled={custom.length === 0}
                >
                  <option value="">My Playlists…</option>
                  {custom.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              )
            })()}
          </div>

          <audio
            ref={audioRef}
            style={{ display: 'none' }}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={() => setIsPlaying(false)}
            onTimeUpdate={(e) => {
              setMainCurrentTime(e.currentTarget.currentTime)
              setMainDuration(e.currentTarget.duration || 0)
            }}
            onDurationChange={(e) => {
              setMainDuration(e.currentTarget.duration || 0)
            }}
          />

          {/* Main Now Playing Panel / Card */}
          <div className="now-playing-card" style={{
            background: 'linear-gradient(135deg, #0b1f2a 0%, #17323f 100%)',
            color: '#fff9ef',
            borderRadius: '16px',
            padding: '16px',
            boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
            marginBottom: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px'
          }}>
            {/* Now-playing strip inside card */}
            {breakInfo ? (
              <div className="now-playing-strip now-playing-break" style={{ background: 'rgba(253, 230, 138, 0.15)', borderColor: 'rgba(240, 192, 64, 0.3)', color: '#fff9ef', border: '1px solid rgba(255,255,255,0.1)', padding: '10px 12px', margin: 0 }}>
                <div className="now-playing-info">
                  <span className="now-playing-title" style={{ color: '#ffd56b' }}>
                    {breakInfo.mode === 'applause' ? '👏 Applause break' : breakInfo.mode === 'countdown' ? '⏳ Countdown break' : '🔇 Silence break'}
                  </span>
                  <span className="now-playing-artist" style={{ color: '#dbeafe' }}>
                    {breakSecondsLeft !== null ? `${breakSecondsLeft}s remaining` : '…'}
                  </span>
                  <div className="now-playing-breakbar" style={{ background: 'rgba(255,255,255,0.1)' }}>
                    <div
                      className="now-playing-breakbar-fill"
                      style={{ width: `${breakSecondsLeft !== null ? (breakSecondsLeft / breakInfo.totalSec) * 100 : 0}%`, background: '#ffd56b' }}
                    />
                  </div>
                </div>
                <span className="now-playing-break-badge" style={{ background: '#ffd56b', color: '#17323f' }}>{breakInfo.totalSec}s</span>
              </div>
            ) : currentTrack ? (
              <div className="now-playing-strip" style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', padding: '10px 12px', margin: 0 }}>
                <div className="now-playing-info">
                  <span className="now-playing-title" style={{ color: '#fff' }}>{cleanDisplayTitle(currentTrack.title)}</span>
                  {currentTrack.artist && <span className="now-playing-artist" style={{ color: '#a0b2bd' }}>{currentTrack.artist}</span>}
                </div>
                <span className="dance-badge now-playing-badge" style={{ background: DANCE_COLORS[currentTrack.danceType] }}>
                  {currentTrack.danceType}
                </span>
              </div>
            ) : (
              <div className="now-playing-strip now-playing-empty" style={{ background: 'rgba(255,255,255,0.03)', border: '1px dashed rgba(255,255,255,0.1)', color: '#8a9aa3', display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '12px' }}>
                No track playing
              </div>
            )}

            {/* Unified Song Progress Bar */}
            {currentTrack && (() => {
              const dur = mainDuration || currentTrack.durationSec || 120
              const cur = mainCurrentTime || 0
              
              // Formatting function for MM:SS
              const fmtSec = (s: number) => {
                const mins = Math.floor(Math.max(0, s) / 60)
                const secs = Math.floor(Math.max(0, s) % 60)
                return `${mins}:${String(secs).padStart(2, '0')}`
              }

              if (settings.wdsfTimedMode) {
                // In timed mode, progress runs from cueStartSec to cueStartSec + targetPlaytimeSec
                const cueStart = currentTrack.cueStartSec || 0
                const targetTime = currentTrack.targetPlaytimeSec || 90
                const limitTime = Math.min(dur, cueStart + targetTime)
                const timeLeft = Math.max(0, limitTime - cur)
                
                // Show the WDSF cue markers inside the bar
                const cuePos = (cueStart / dur) * 100
                const endPos = (limitTime / dur) * 100
                const fullPct = Math.min(100, Math.max(0, (cur / dur) * 100))

                return (
                  <div className="cue-bar-wrap" style={{ margin: '4px 0 2px' }}>
                    <div className="cue-bar" style={{ background: 'rgba(255,255,255,0.15)', height: '8px', borderRadius: '4px', position: 'relative' }}>
                      <div className="cue-bar-active" style={{ position: 'absolute', height: '100%', left: `${cuePos}%`, width: `${endPos - cuePos}%`, background: '#4cd8b0', opacity: 0.3 }} />
                      <div className="cue-bar-progress" style={{ position: 'absolute', height: '100%', left: 0, width: `${fullPct}%`, background: '#4cd8b0', borderRadius: '4px' }} />
                      <div className="cue-marker cue-marker-start" style={{ position: 'absolute', left: `${cuePos}%`, background: '#fff', width: '2px', height: '12px', top: '-2px' }} title={`Cue: ${fmtSec(cueStart)}`} />
                      <div className="cue-marker cue-marker-end" style={{ position: 'absolute', left: `${endPos}%`, background: '#fff', width: '2px', height: '12px', top: '-2px' }} title={`End: ${fmtSec(limitTime)}`} />
                    </div>
                    <div className="cue-bar-labels" style={{ display: 'flex', justifyContent: 'space-between', color: '#a0b2bd', fontSize: '0.75rem', marginTop: '4px' }}>
                      <span>▶ {fmtSec(cur)} / {fmtSec(limitTime)} (Cue: {fmtSec(cueStart)})</span>
                      <span style={{ fontWeight: 'bold', color: '#4cd8b0' }}>-{fmtSec(timeLeft)} left</span>
                    </div>
                  </div>
                )
              } else {
                // In untimed mode, progress runs from 0 to dur (full song)
                const pct = Math.min(100, Math.max(0, (cur / dur) * 100))
                const timeLeft = Math.max(0, dur - cur)

                return (
                  <div className="cue-bar-wrap" style={{ margin: '4px 0 2px' }}>
                    <div className="cue-bar" style={{ background: 'rgba(255,255,255,0.15)', height: '8px', borderRadius: '4px', position: 'relative', overflow: 'hidden' }}>
                      <div className="cue-bar-progress" style={{ position: 'absolute', height: '100%', left: 0, width: `${pct}%`, background: '#4cd8b0' }} />
                    </div>
                    <div className="cue-bar-labels" style={{ display: 'flex', justifyContent: 'space-between', color: '#a0b2bd', fontSize: '0.75rem', marginTop: '4px' }}>
                      <span>▶ {fmtSec(cur)} / {fmtSec(dur)}</span>
                      <span style={{ fontWeight: 'bold', color: '#4cd8b0' }}>-{fmtSec(timeLeft)} left</span>
                    </div>
                  </div>
                )
              }
            })()}

            {/* Custom playback controls inside card */}
            <div className="player-controls" style={{ display: 'flex', gap: '8px', justifyContent: 'center', margin: '4px 0', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="ctrl-btn main-play-btn"
                title={isPlaying ? "Pause" : "Play"}
                onClick={togglePlayPause}
                style={{
                  background: isPlaying ? '#00b06b' : '#0c6b69',
                  color: '#fff',
                  borderColor: 'rgba(255,255,255,0.15)',
                  fontSize: '1.1rem',
                  padding: '8px 20px',
                  borderRadius: '12px',
                  flex: '1 1 100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 'bold',
                  transition: 'background 0.2s'
                }}
              >
                {isPlaying ? '⏸ Pause' : '▶ Play'}
              </button>
              <button type="button" className="ctrl-btn" style={{ background: 'rgba(255,255,255,0.1)', color: '#fff', borderColor: 'rgba(255,255,255,0.1)', flex: '1 1 50px' }} title="Restart track" onClick={repeatSong}>↺ Restart</button>
              <button type="button" className="ctrl-btn" style={{ background: 'rgba(255,255,255,0.1)', color: '#fff', borderColor: 'rgba(255,255,255,0.1)', flex: '1 1 50px' }} title="−15 seconds" onClick={() => seekBy(-15)}>-15s</button>
              <button type="button" className="ctrl-btn" style={{ background: 'rgba(255,255,255,0.1)', color: '#fff', borderColor: 'rgba(255,255,255,0.1)', flex: '1 1 50px' }} title="+15 seconds" onClick={() => seekBy(15)}>+15s</button>
              <button type="button" className="ctrl-btn" style={{ background: 'rgba(255,255,255,0.1)', color: '#fff', borderColor: 'rgba(255,255,255,0.1)', flex: '1 1 50px' }} title="Next track" onClick={nextSong}>⏭ Next</button>
            </div>

            {/* Speed row inside card */}
            <div className="player-speed-row" style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '4px 0 0' }}>
              <button type="button" className="ctrl-btn speed-btn" style={{ background: 'rgba(255,255,255,0.1)', color: '#fff', borderColor: 'rgba(255,255,255,0.1)', padding: '5px 10px' }} onClick={() => applySpeedDelta(-10)}>−10%</button>
              <input
                type="range"
                className="speed-slider"
                style={{ flex: 1 }}
                min={-50}
                max={50}
                value={settings.speedPct}
                onChange={(e) => setSettings((prev) => ({ ...prev, speedPct: clampSpeed(Number(e.target.value)) }))}
              />
              <button type="button" className="ctrl-btn speed-btn" style={{ background: 'rgba(255,255,255,0.1)', color: '#fff', borderColor: 'rgba(255,255,255,0.1)', padding: '5px 10px' }} onClick={() => applySpeedDelta(10)}>+10%</button>
              <span className="speed-label" style={{ color: '#fff9ef', fontSize: '0.85rem', minWidth: '45px', textAlign: 'right' }}>{settings.speedPct > 0 ? '+' : ''}{settings.speedPct}%</span>
            </div>
          </div>

          {/* Settings & Automation collapsible card */}
          <details className="settings-automation-card" style={{
            background: 'linear-gradient(135deg, #102430 0%, #1c3d4e 100%)',
            color: '#fff9ef',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '12px',
            padding: '12px',
            marginBottom: '16px'
          }}>
            <summary style={{ fontWeight: 'bold', fontSize: '0.95rem', color: '#fff9ef', cursor: 'pointer', outline: 'none', listStyle: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>⚙ Settings &amp; Automation</span>
              <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>▼</span>
            </summary>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '10px' }}>
              <div className="row compact" style={{ margin: 0 }}>
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
              <div>
                <h4 style={{ margin: '0 0 6px', fontSize: '0.9rem', borderBottom: '1px solid rgba(255, 255, 255, 0.15)', paddingBottom: '4px' }}>Break between tracks</h4>
                <div className="row compact" style={{ margin: 0 }}>
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
                  <div className="row compact break-settings-row" style={{ marginTop: '8px', marginBottom: 0 }}>
                    <label style={{ color: '#fff9ef' }}>
                      Duration
                      <select
                        value={sessionRule.breakDurationSec}
                        onChange={(e) => setSessionRule((prev) => ({ ...prev, breakDurationSec: Number(e.target.value) }))}
                        style={{ background: '#1c3d4e', color: '#fff9ef', borderColor: 'rgba(255, 255, 255, 0.2)' }}
                      >
                        {Array.from({ length: 24 }, (_, i) => (i + 1) * 5).map((s) => (
                          <option key={s} value={s}>{s}s</option>
                        ))}
                      </select>
                    </label>
                    <label style={{ color: '#fff9ef' }}>
                      Mode
                      <select
                        value={sessionRule.breakMode ?? 'countdown'}
                        onChange={(e) => setSessionRule((prev) => ({ ...prev, breakMode: e.target.value as SessionRule['breakMode'] }))}
                        style={{ background: '#1c3d4e', color: '#fff9ef', borderColor: 'rgba(255, 255, 255, 0.2)' }}
                      >
                        <option value="silence">Silence</option>
                        <option value="countdown">Countdown</option>
                        <option value="applause">Applause</option>
                      </select>
                    </label>
                  </div>
                )}
              </div>

              {/* Voice commands */}
              <div>
                <h4 style={{ margin: '0 0 6px', fontSize: '0.9rem', borderBottom: '1px solid rgba(255, 255, 255, 0.15)', paddingBottom: '4px' }}>Voice commands</h4>
                {!window.isSecureContext && (
                  <div className="https-warning" style={{ background: '#3b2f0f', borderColor: '#e6b84a', color: '#ffd073' }}>
                    Voice requires HTTPS.
                  </div>
                )}
                <div className="row compact" style={{ margin: 0 }}>
                  <button
                    type="button"
                    className={isListening ? 'live' : ''}
                    onClick={toggleVoiceListening}
                    style={{ background: isListening ? '#00b06b' : 'rgba(255, 255, 255, 0.1)', color: '#fff', borderColor: isListening ? '#006e41' : 'rgba(255,255,255,0.15)' }}
                  >
                    {isListening ? '🎙 Listening…' : '🎙 Voice Command'}
                  </button>
                </div>
                <p className="hint" style={{ marginTop: '6px', color: '#a0b2bd' }}>
                  Commands (EN+DE): slower/langsamer · faster/schneller · next song/nächstes Lied · repeat/wiederholen · play {'<dance>'}/spiele {'<dance>'}
                </p>
                {repeatAnnounce && <p className="hint" style={{ marginTop: '4px', color: '#a0b2bd' }}>Last announcement: {repeatAnnounce}</p>}
              </div>
            </div>
          </details>

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
                      <span className="dance-badge pq-badge" style={{ background: DANCE_COLORS[t.danceType] }} title={t.danceType}>
                        {DANCE_ABBR[t.danceType]}
                      </span>
                      <span className="pq-info" style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        {isActive && <span className="pq-now-playing-label">▶ Now playing</span>}
                        <span className="pq-title">{cleanDisplayTitle(t.title)}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <div style={{ display: 'inline-flex', gap: '0px', fontSize: '0.8rem', userSelect: 'none', lineHeight: 1 }} onClick={(e) => e.stopPropagation()}>
                            {[1, 2, 3, 4, 5].map((star) => {
                              const isFilled = star <= (t.qualityRating ?? 0)
                              return (
                                <span
                                  key={star}
                                  onClick={() => {
                                    const newRating = t.qualityRating === star ? 0 : star
                                    updateTrack(t.id, { qualityRating: newRating })
                                  }}
                                  style={{
                                    cursor: 'pointer',
                                    color: isFilled ? 'var(--sun)' : 'rgba(232, 159, 62, 0.22)',
                                    padding: '0 1px',
                                    display: 'inline-block',
                                  }}
                                  title={isFilled ? `Remove star ${star}` : `Rate ${star} star${star > 1 ? 's' : ''}`}
                                >
                                  ★
                                </span>
                              )
                            })}
                          </div>
                          {t.artist && <span className="pq-artist" style={{ margin: 0 }}>{t.artist}</span>}
                        </div>
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
        <>
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
            style={{ display: 'none' }}
          />
        </section>

        <section className="panel panel-backup" style={{ marginTop: '20px' }}>
          <h2>Desktop Helper Tool</h2>
          <p className="hint">
            To view, edit, or adjust audio file ratings directly on your local computer, download the standalone rating editor utility.
          </p>
          
          <div className="helper-tool-card" style={{ marginTop: '15px' }}>
            <h3>Audio Rating Editor</h3>
            <p className="hint">
              This utility scans a directory, displays metadata tags (Artist, Album, Title), supports test playback, and allows setting stars that write directly back into the MP3's Popularimeter (POPM) tag.
            </p>
            
            <div style={{ marginTop: '15px', marginBottom: '15px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <button type="button" onClick={downloadRatingEditorExe} style={{ background: '#00b06b', color: '#ffffff' }}>
                🚀 Download for Windows (.exe)
              </button>
              <button type="button" onClick={downloadRatingEditor}>
                🐍 Download Python Script (.py)
              </button>
            </div>
            
            <div className="setup-instructions" style={{ marginTop: '15px', padding: '15px', background: 'rgba(255, 255, 255, 0.05)', borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.1)' }}>
              <h4 style={{ margin: '0 0 10px 0', fontSize: '15px', fontWeight: 'bold' }}>Quick Setup Instructions:</h4>
              <ul className="hint" style={{ paddingLeft: '20px', margin: 0, display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px', lineHeight: '1.5', listStyleType: 'disc' }}>
                <li>
                  <strong>Windows users:</strong> Simply download the <code>.exe</code> above and run it directly. No Python or libraries required!
                </li>
                <li>
                  <strong>Mac / Linux users:</strong> Download the <code>.py</code> script, ensure Python is installed, then:
                  <ol style={{ paddingLeft: '20px', marginTop: '5px', display: 'flex', flexDirection: 'column', gap: '4px', listStyleType: 'decimal' }}>
                    <li>Open terminal and install dependencies:
                      <code style={{ display: 'block', margin: '4px 0', padding: '6px', background: '#121214', borderRadius: '4px', border: '1px solid #333', color: '#00b06b', fontFamily: 'monospace' }}>
                        pip install mutagen just_playback
                      </code>
                    </li>
                    <li>Run the script:
                      <code style={{ display: 'block', margin: '4px 0', padding: '6px', background: '#121214', borderRadius: '4px', border: '1px solid #333', color: '#00b06b', fontFamily: 'monospace' }}>
                        python rating_editor.py
                      </code>
                    </li>
                  </ol>
                </li>
              </ul>
            </div>
          </div>
        </section>
        </>
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
              const sortMode = dancePlaylistSorts[dp.id] ?? 'name'
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }} onClick={(e) => e.stopPropagation()}>
                      <span className="dance-playlist-card-count">{dp.entries.length} track{dp.entries.length !== 1 ? 's' : ''}</span>
                      <div style={{ display: 'inline-flex', gap: '2px', background: 'rgba(0,0,0,0.22)', borderRadius: '5px', padding: '2px' }}>
                        <button
                          type="button"
                          title="Sort by Name"
                          onClick={() => setDancePlaylistSorts((prev) => ({ ...prev, [dp.id]: 'name' }))}
                          style={{
                            padding: '3px',
                            border: 'none',
                            background: sortMode === 'name' ? 'rgba(255,255,255,0.25)' : 'transparent',
                            color: '#fff',
                            cursor: 'pointer',
                            borderRadius: '3px',
                            lineHeight: 1,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
                            <path d="M4 6h9M4 12h7M4 18h7M17 6v12M17 18l-3-3M17 18l3-3" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          title="Sort by Stars"
                          onClick={() => setDancePlaylistSorts((prev) => ({ ...prev, [dp.id]: 'stars' }))}
                          style={{
                            padding: '3px',
                            border: 'none',
                            background: sortMode === 'stars' ? 'rgba(255,255,255,0.25)' : 'transparent',
                            color: '#fff',
                            cursor: 'pointer',
                            borderRadius: '3px',
                            lineHeight: 1,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
                            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </summary>
                  <div className="dance-playlist-tracks">
                    {(() => {
                      const sorted = [...dp.entries].sort((a, b) => {
                        if (a.type !== 'track' || b.type !== 'track') return 0
                        const trackA = tracksById[a.trackId]
                        const trackB = tracksById[b.trackId]
                        if (!trackA || !trackB) return 0
                        if (sortMode === 'stars') {
                          const diff = (trackB.qualityRating ?? 0) - (trackA.qualityRating ?? 0)
                          if (diff !== 0) return diff
                        }
                        return cleanDisplayTitle(trackA.title).localeCompare(cleanDisplayTitle(trackB.title))
                      })
                      return sorted.map((entry, idx) => {
                        if (entry.type !== 'track') return null
                        const t = tracksById[entry.trackId]
                        if (!t) return null
                        const isMarked = playlist.entries.some((e) => e.type === 'track' && e.trackId === entry.trackId)
                        return (
                          <div key={entry.id} className={`dance-playlist-track-row ${isMarked ? 'marked' : ''}`}>
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
                              }}
                              style={{
                                border: `1.5px solid ${isMarked ? 'var(--ok)' : '#7a8a95'}`,
                                borderRadius: '50%',
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                width: '24px',
                                height: '24px',
                                minWidth: '24px',
                                padding: 0,
                                background: isMarked ? 'var(--ok)' : 'transparent',
                                color: isMarked ? '#fff' : '#7a8a95',
                                fontWeight: 'bold',
                                fontSize: '0.85rem',
                                cursor: 'pointer',
                                transition: 'all 0.12s',
                                flexShrink: 0,
                                outline: 'none',
                                lineHeight: 1,
                                marginRight: '4px',
                              }}
                            >
                              {idx + 1}
                            </button>
                              <div className="dance-track-info" style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                <span className="dance-track-title">{cleanDisplayTitle(t.title)}</span>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                  <div style={{ display: 'inline-flex', gap: '0px', fontSize: '0.85rem', userSelect: 'none', lineHeight: 1 }} onClick={(e) => e.stopPropagation()}>
                                    {[1, 2, 3, 4, 5].map((star) => {
                                      const isFilled = star <= (t.qualityRating ?? 0)
                                      return (
                                        <span
                                          key={star}
                                          onClick={() => {
                                            const newRating = t.qualityRating === star ? 0 : star
                                            updateTrack(t.id, { qualityRating: newRating })
                                          }}
                                          style={{
                                            cursor: 'pointer',
                                            color: isFilled ? 'var(--sun)' : 'rgba(232, 159, 62, 0.22)',
                                            padding: '0 1px',
                                            display: 'inline-block',
                                          }}
                                          title={isFilled ? `Remove star ${star}` : `Rate ${star} star${star > 1 ? 's' : ''}`}
                                        >
                                          ★
                                        </span>
                                      )
                                    })}
                                  </div>
                                  </div>
                              </div>
                            <button
                              type="button"
                              className={previewingTrackId === entry.trackId ? 'previewing' : ''}
                              title={previewingTrackId === entry.trackId ? 'Stop preview' : 'Preview'}
                              onClick={(e) => { e.stopPropagation(); void togglePreview(entry.trackId) }}
                              style={{ marginRight: '4px' }}
                            >{previewingTrackId === entry.trackId ? '■' : '▶'}</button>
                            <button
                              type="button"
                              className="track-row-pencil-btn"
                              title="Edit track"
                              onClick={(e) => { e.stopPropagation(); setEditingTrackId(t.id) }}
                            >✎</button>
                        </div>
                      )
                    })
                  })()}
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
          <div className="edit-modal-overlay" onClick={() => {
            const pa = previewAudioRef.current
            if (!pa.paused) {
              pa.pause()
              if (previewObjectUrlRef.current) {
                URL.revokeObjectURL(previewObjectUrlRef.current)
                previewObjectUrlRef.current = null
              }
              setPreviewingTrackId(null)
            }
            setEditingTrackId(null)
          }}>
            <div className="edit-modal" onClick={(e) => e.stopPropagation()}>
              <h3 className="edit-modal-title" style={{ marginBottom: '2px' }}>Edit Track</h3>
              {t.filename && (
                <div style={{ fontSize: '0.72rem', color: '#8a9aa3', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: '2px' }}>
                  File: {t.filename}
                </div>
              )}
              <div className="edit-modal-row">
                <label className="edit-modal-field half">
                  <span className="edit-modal-label">Title</span>
                  <input
                    type="text"
                    className="edit-modal-input"
                    value={t.title}
                    onChange={(e) => updateTrack(t.id, { title: e.target.value })}
                  />
                </label>
                <label className="edit-modal-field half">
                  <span className="edit-modal-label">Artist</span>
                  <input
                    type="text"
                    className="edit-modal-input"
                    value={t.artist ?? ''}
                    placeholder="Artist name"
                    onChange={(e) => updateTrack(t.id, { artist: e.target.value || undefined })}
                  />
                </label>
              </div>
              <div className="edit-modal-row" style={{ alignItems: 'center' }}>
                <label className="edit-modal-field half">
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
                <label className="edit-modal-field half">
                  <span className="edit-modal-label">Rating</span>
                  <div style={{ display: 'flex', gap: '5px', fontSize: '1.25rem', cursor: 'pointer', color: 'var(--sun)', userSelect: 'none', margin: '2px 0' }}>
                    {[1, 2, 3, 4, 5].map((star) => (
                      <span
                        key={star}
                        onClick={() => {
                          const newRating = t.qualityRating === star ? 0 : star
                          updateTrack(t.id, { qualityRating: newRating })
                        }}
                        title={`${star} Star${star > 1 ? 's' : ''}`}
                      >
                        {star <= (t.qualityRating ?? 0) ? '★' : '☆'}
                      </span>
                    ))}
                  </div>
                </label>
              </div>
              <div className="edit-modal-row">
                <label className="edit-modal-field half">
                  <span className="edit-modal-label">Cue (s)</span>
                  <input
                    type="number" min={0} step={0.1} className="edit-modal-input"
                    value={t.cueStartSec}
                    onChange={(e) => updateTrack(t.id, { cueStartSec: Number(e.target.value) })}
                  />
                  <input
                    type="range" min={0} max={t.durationSec || 300} step={1}
                    value={t.cueStartSec}
                    onChange={(e) => updateTrack(t.id, { cueStartSec: Number(e.target.value) })}
                    style={{ width: '100%', marginTop: '6px' }}
                  />
                </label>
                <label className="edit-modal-field half">
                  <span className="edit-modal-label">Playtime (s)</span>
                  <input
                    type="number" min={10} className="edit-modal-input"
                    value={t.targetPlaytimeSec}
                    onChange={(e) => updateTrack(t.id, { targetPlaytimeSec: Number(e.target.value) })}
                  />
                  <input
                    type="range" min={10} max={t.durationSec || 300} step={1}
                    value={t.targetPlaytimeSec}
                    onChange={(e) => updateTrack(t.id, { targetPlaytimeSec: Number(e.target.value) })}
                    style={{ width: '100%', marginTop: '6px' }}
                  />
                </label>
                <label className="edit-modal-field half">
                  <span className="edit-modal-label">Fade (s)</span>
                  <input
                    type="number" min={1} max={10} className="edit-modal-input"
                    value={t.fadeOutSec}
                    onChange={(e) => updateTrack(t.id, { fadeOutSec: Number(e.target.value) })}
                  />
                  <input
                    type="range" min={1} max={10} step={0.5}
                    value={t.fadeOutSec}
                    onChange={(e) => updateTrack(t.id, { fadeOutSec: Number(e.target.value) })}
                    style={{ width: '100%', marginTop: '6px' }}
                  />
                </label>
              </div>
              <div className="edit-modal-player" style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px', background: 'var(--sand)', borderRadius: '10px' }}>
                <span className="edit-modal-label" style={{ fontWeight: 'bold' }}>Test Playback</span>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    onClick={() => void togglePreview(t.id)}
                    className={previewingTrackId === t.id ? 'live' : ''}
                    style={{ flex: 1 }}
                  >
                    {previewingTrackId === t.id ? '⏹ Stop' : '▶ Play (from Cue)'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const pa = previewAudioRef.current
                      if (!pa.paused) {
                        pa.currentTime = 0
                      } else {
                        void togglePreview(t.id).then(() => {
                          previewAudioRef.current.currentTime = 0
                        })
                      }
                    }}
                    style={{ flex: 1 }}
                  >
                    ⏮ From Start
                  </button>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.8rem', marginTop: '4px' }}>
                  <button
                    type="button"
                    onClick={() => {
                      const pa = previewAudioRef.current
                      if (!pa.paused) {
                        pa.currentTime = Math.max(0, pa.currentTime - 5)
                      }
                    }}
                    disabled={previewingTrackId !== t.id}
                  >
                    -5s
                  </button>
                  {(() => {
                    const dur = previewDuration || t.durationSec || 120
                    const cuePos = (t.cueStartSec / dur) * 100
                    const endSec = Math.min(dur, t.cueStartSec + t.targetPlaytimeSec)
                    const endPos = (endSec / dur) * 100
                    const curTime = previewingTrackId === t.id ? previewCurrentTime : 0
                    const progressPos = (curTime / dur) * 100
                    return (
                      <div className="preview-cue-bar" style={{
                        flex: 1,
                        height: '8px',
                        background: 'var(--line)',
                        borderRadius: '4px',
                        position: 'relative',
                        overflow: 'hidden',
                        margin: '0 8px'
                      }} title={`Cue: ${t.cueStartSec}s, Playtime: ${t.targetPlaytimeSec}s`}>
                        {/* Highlighted active range (Cue -> Cue + Playtime) */}
                        <div style={{
                          position: 'absolute',
                          left: `${cuePos}%`,
                          width: `${endPos - cuePos}%`,
                          height: '100%',
                          background: 'rgba(44, 181, 116, 0.28)'
                        }} />
                        {/* Played progress fill */}
                        {previewingTrackId === t.id && (
                          <div style={{
                            position: 'absolute',
                            left: 0,
                            top: 0,
                            width: `${progressPos}%`,
                            height: '100%',
                            background: 'var(--ok)',
                            opacity: 0.8,
                            transition: 'width 0.1s linear'
                          }} />
                        )}
                        {/* Cue start vertical indicator line */}
                        <div style={{
                          position: 'absolute',
                          left: `${cuePos}%`,
                          width: '1.5px',
                          height: '100%',
                          background: 'var(--paper)',
                          transform: 'translateX(-50%)',
                          opacity: 0.95,
                          zIndex: 2
                        }} />
                        {/* Playtime end vertical indicator line */}
                        <div style={{
                          position: 'absolute',
                          left: `${endPos}%`,
                          width: '1.5px',
                          height: '100%',
                          background: 'var(--paper)',
                          transform: 'translateX(-50%)',
                          opacity: 0.95,
                          zIndex: 2
                        }} />
                      </div>
                    )
                  })()}
                  <button
                    type="button"
                    onClick={() => {
                      const pa = previewAudioRef.current
                      if (!pa.paused) {
                        pa.currentTime = Math.min(pa.duration || 9999, pa.currentTime + 5)
                      }
                    }}
                    disabled={previewingTrackId !== t.id}
                  >
                    +5s
                  </button>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--night)', padding: '0 8px', marginTop: '4px', opacity: 0.8 }}>
                  <span>
                    ▶ {formatTime(previewingTrackId === t.id ? previewCurrentTime : 0)} / {formatTime(t.durationSec || 0)}
                  </span>
                  <span>
                    Cue: {formatTime(t.cueStartSec)} · End: {formatTime(Math.min(t.durationSec || 0, t.cueStartSec + t.targetPlaytimeSec))}
                  </span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px', marginTop: '8px', width: '100%' }}>
                <button
                  type="button"
                  className="btn-danger"
                  style={{ flex: 1, padding: '10px 12px', margin: 0 }}
                  onClick={() => {
                    if (!window.confirm(`Delete "${t.title}" permanently?`)) return
                    const pa = previewAudioRef.current
                    if (!pa.paused) {
                      pa.pause()
                      if (previewObjectUrlRef.current) {
                        URL.revokeObjectURL(previewObjectUrlRef.current)
                        previewObjectUrlRef.current = null
                      }
                      setPreviewingTrackId(null)
                    }
                    // Record in history
                    markTrackAsRemoved(t.hash, t.filename, t.title)
                    // Permanently delete
                    void removeAudioFile(t.id)
                    setTracks((prev) => prev.filter((x) => x.id !== t.id))
                    setFileMap((prev) => {
                      const next = { ...prev }
                      delete next[t.id]
                      return next
                    })
                    setPlaylist((prev) => ({
                      ...prev,
                      entries: prev.entries.filter((en) => en.type !== 'track' || en.trackId !== t.id)
                    }))
                    setDancePlaylists((prev) => prev.map((p) => ({
                      ...p,
                      entries: p.entries.filter((en) => en.type !== 'track' || en.trackId !== t.id)
                    })))
                    setSavedPlaylists((prev) => prev.map((p) => ({
                      ...p,
                      entries: p.entries.filter((en) => en.type !== 'track' || en.trackId !== t.id)
                    })))
                    setStatus(`Deleted "${t.title}" permanently.`)
                    setEditingTrackId(null)
                  }}
                >
                  ✕ Remove
                </button>
                <button
                  type="button"
                  className="edit-modal-close cta"
                  style={{ flex: 1, padding: '10px 12px', margin: 0, alignSelf: 'stretch' }}
                  onClick={() => {
                    const pa = previewAudioRef.current
                    if (!pa.paused) {
                      pa.pause()
                      if (previewObjectUrlRef.current) {
                        URL.revokeObjectURL(previewObjectUrlRef.current)
                        previewObjectUrlRef.current = null
                      }
                      setPreviewingTrackId(null)
                    }
                    setEditingTrackId(null)
                  }}
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

export default App

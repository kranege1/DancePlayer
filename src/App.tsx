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
  type BeatPair,
} from './types'
import { clearAllAudioFiles, getAudioFile, saveAudioFile, removeAudioFile } from './mediaStore'
import { analyzeTrackRhythm } from './analysis'
import { getFadeWindow } from './playbackMath'
import { lookupTrackOnMusicBrainz } from './musicbrainz'
import { parseFilenamesWithGrok, type GrokTrackInfo } from './grok'
import danceShapeUrl from './DanceShape.png'

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
  playSequence: 'default',
  repeatPlaylist: false,
  tapLatencyMs: 100,
}

const initialPlaylist: Playlist = {
  id: 'playlist-main',
  name: 'Practice Queue',
  entries: [],
}

const initialSessionRule: SessionRule = {
  danceType: 'Tango',
  autoBreakEnabled: true,
  breakDurationSec: 15,
  breakMode: 'countdown',
  announcementEnabled: false,
}

function createId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

function clampSpeed(value: number) {
  return Math.max(-30, Math.min(30, Math.round(value)))
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

const BEATS_PER_BAR: Record<DanceType, number> = {
  Samba: 2,
  ChaCha: 4,
  Rumba: 4,
  'Paso Doble': 2,
  Jive: 4,
  Waltz: 3,
  Tango: 4,
  'Viennese Waltz': 3,
  Foxtrot: 4,
  Quickstep: 4,
  Other: 4,
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

function playBeep() {
  try {
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.connect(gain)
    gain.connect(audioCtx.destination)
    
    osc.frequency.setValueAtTime(800, audioCtx.currentTime)
    gain.gain.setValueAtTime(0, audioCtx.currentTime)
    gain.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.00001, audioCtx.currentTime + 0.12)
    
    osc.start(audioCtx.currentTime)
    osc.stop(audioCtx.currentTime + 0.12)
  } catch (err) {
    console.error('Failed to play calibration beep:', err)
  }
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
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [status, setStatus] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return raw ? 'Metadata restored. Cached audio will load on demand from device storage.' : 'Ready'
    } catch {
      return 'Could not restore saved metadata.'
    }
  })
  const [currentWaveform, setCurrentWaveform] = useState<number[] | null>(null)
  const [zoomWaveform, setZoomWaveform] = useState<number[] | null>(null)

  const [tapTimes, setTapTimes] = useState<number[]>([])
  const decodedAudioBufferRef = useRef<AudioBuffer | null>(null)
  const [dancePlaylistSorts, setDancePlaylistSorts] = useState<Record<string, 'name' | 'stars'>>(() => persistedState.dancePlaylistSorts ?? {})
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null)
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

  // Latency calibration state
  const [isCalibratingLatency, setIsCalibratingLatency] = useState(false)
  const [calibrationTaps, setCalibrationTaps] = useState<number[]>([])
  const [calibrationResult, setCalibrationResult] = useState<number | null>(null)
  const [calibrationFlash, setCalibrationFlash] = useState(false)
  const calibrationTimerRef = useRef<any>(null)
  const calibrationBeepsRef = useRef<number[]>([])
  const calibrationTapsRef = useRef<number[]>([])

  function startCalibration() {
    setIsCalibratingLatency(true)
    setCalibrationTaps([])
    setCalibrationResult(null)
    calibrationBeepsRef.current = []
    calibrationTapsRef.current = []
    if (calibrationTimerRef.current) {
      clearTimeout(calibrationTimerRef.current)
    }
    
    let beepsPlayed = 0
    const maxBeeps = 25
    const interval = 1200
    
    const nextBeep = () => {
      if (calibrationTapsRef.current.length >= 10 || beepsPlayed >= maxBeeps) {
        setTimeout(() => {
          calculateCalibrationResult()
        }, 800)
        return
      }
      
      playBeep()
      const now = performance.now()
      calibrationBeepsRef.current.push(now)
      beepsPlayed++
      calibrationTimerRef.current = setTimeout(nextBeep, interval)
    }
    
    calibrationTimerRef.current = setTimeout(nextBeep, 800)
  }

  function cancelCalibration() {
    setIsCalibratingLatency(false)
    if (calibrationTimerRef.current) {
      clearTimeout(calibrationTimerRef.current)
      calibrationTimerRef.current = null
    }
  }

  function calculateCalibrationResult() {
    const beeps = calibrationBeepsRef.current
    const taps = calibrationTapsRef.current
    const diffs: number[] = []
    taps.forEach(tap => {
      let closestBeep = 0
      let minDiff = Infinity
      beeps.forEach(beep => {
        const diff = Math.abs(tap - beep)
        if (diff < minDiff) {
          minDiff = diff
          closestBeep = beep
        }
      })
      if (minDiff < 500) {
        const delay = tap - closestBeep
        if (delay > -100 && delay < 500) {
          diffs.push(delay)
        }
      }
    })
    
    if (diffs.length > 0) {
      const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length
      const finalLatency = Math.max(0, Math.min(400, Math.round(avg / 10) * 10))
      setCalibrationResult(finalLatency)
    } else {
      setCalibrationResult(0)
    }
  }

  const handleCalibrationTap = () => {
    const now = performance.now()
    setCalibrationFlash(true)
    setTimeout(() => setCalibrationFlash(false), 80)
    setCalibrationTaps(prev => {
      const next = [...prev, now]
      calibrationTapsRef.current = next
      return next
    })
  }

  useEffect(() => {
    if (!isCalibratingLatency) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault()
        handleCalibrationTap()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isCalibratingLatency])

  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null)
  const [dancePlaylists, setDancePlaylists] = useState<Playlist[]>(() => persistedState.dancePlaylists ?? [])
  const [savedPlaylists, setSavedPlaylists] = useState<Playlist[]>(() => persistedState.savedPlaylists ?? [])
  const [activeTab, setActiveTab] = useState<'songs' | 'playlists' | 'player' | 'export'>('songs')
  const [editingTrackId, setEditingTrackId] = useState<string | null>(null)
  const [zoomBarsCount] = useState(3)
  const zoomCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const zoomBeatPillRef = useRef<HTMLDivElement | null>(null)
  const zoomAnimationFrameRef = useRef<number | null>(null)
  const dancerCountSpansRef = useRef<(HTMLSpanElement | null)[]>([])
  const [isPlaying, setIsPlaying] = useState(false)
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
  const countdownSpeechTimeoutsRef = useRef<number[]>([])

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

  useEffect(() => {
    const visibleIds = new Set(visibleTracks.map((t) => t.id))
    setSelectedTrackIds((prev) => {
      const next = new Set<string>()
      prev.forEach((id) => {
        if (visibleIds.has(id)) {
          next.add(id)
        }
      })
      if (next.size !== prev.size) {
        return next
      }
      return prev
    })
  }, [visibleTracks])

  const playableEntries = useMemo(() => {
    const seq = settings.playSequence ?? 'default'
    if (seq === 'rating') {
      const tracksOnly = playlist.entries.filter(e => e.type === 'track')
      const breaksOnly = playlist.entries.filter(e => e.type === 'break')
      const sortedTracks = [...tracksOnly].sort((a, b) => {
        const ratingA = tracksById[a.trackId]?.qualityRating ?? 0
        const ratingB = tracksById[b.trackId]?.qualityRating ?? 0
        if (ratingB !== ratingA) {
          return ratingB - ratingA
        }
        const titleA = tracksById[a.trackId]?.title ?? ''
        const titleB = tracksById[b.trackId]?.title ?? ''
        return titleA.localeCompare(titleB)
      })
      return [...sortedTracks, ...breaksOnly]
    }
    if (seq === 'shuffle') {
      const hashString = (str: string) => {
        let hash = 0
        for (let i = 0; i < str.length; i++) {
          hash = str.charCodeAt(i) + ((hash << 5) - hash)
        }
        return hash
      }
      return [...playlist.entries].sort((a, b) => {
        return hashString(a.id) - hashString(b.id)
      })
    }
    return playlist.entries
  }, [playlist.entries, settings.playSequence, tracksById])

  const currentIndex = playableEntries.findIndex((entry) => entry.id === activeEntryId)

  const activeDanceType = useMemo(() => {
    const entry = playableEntries.find((e) => e.id === activeEntryId)
    if (!entry || entry.type !== 'track') return null
    return tracksById[entry.trackId]?.danceType ?? null
  }, [activeEntryId, playableEntries, tracksById])

  const currentTrack = useMemo(() => {
    const entry = playableEntries.find((e) => e.id === activeEntryId)
    if (!entry || entry.type !== 'track') return null
    return tracksById[entry.trackId] ?? null
  }, [activeEntryId, playableEntries, tracksById])

  // Derived state: calculate current beat number if playing and aligned
  const beat1Times = useMemo(() => {
    if (!currentTrack || !currentTrack.beatPairs || currentTrack.beatPairs.length === 0) {
      return []
    }
    const dur = mainDuration || currentTrack.durationSec || 120
    const pairs = [...currentTrack.beatPairs].sort((a, b) => a.t1 - b.t1)
    const lateBeat = currentTrack.lateBeatSec
    const fineTuneOffset = currentTrack.intervalOffsetSec || 0

    const list: number[] = []
    const firstPair = pairs[0]

    // Determine base interval
    let I_base = firstPair.t2 - firstPair.t1

    if (pairs.length === 1 && lateBeat !== undefined && lateBeat > firstPair.t2 && I_base > 0) {
      const numBars = Math.round((lateBeat - firstPair.t2) / I_base)
      if (numBars > 0) {
        I_base = (lateBeat - firstPair.t2) / numBars
      }
    }

    const I_final = I_base + fineTuneOffset

    if (I_final > 0) {
      // Generate uniform grid using I_final starting from firstPair.t1
      let t = firstPair.t1
      while (t >= 0) {
        list.unshift(t)
        t -= I_final
      }
      t = firstPair.t1 + I_final
      while (t < dur) {
        list.push(t)
        t += I_final
      }
    }

    return Array.from(new Set(list)).sort((a, b) => a - b)
  }, [currentTrack, mainDuration])

  const currentBeatNum = useMemo(() => {
    if (!currentTrack || beat1Times.length === 0) {
      return null
    }
    const cur = mainCurrentTime || 0
    const beatsPerBar = BEATS_PER_BAR[currentTrack.danceType] || 4

    let barStart = beat1Times[0]
    let barEnd = beat1Times[1] ?? (barStart + 2.0)
    
    if (cur < beat1Times[0]) {
      const interval = (beat1Times[1] ?? (beat1Times[0] + 2.0)) - beat1Times[0]
      const elapsed = beat1Times[0] - cur
      const barsBefore = Math.ceil(elapsed / interval)
      barStart = beat1Times[0] - barsBefore * interval
      barEnd = barStart + interval
    } else {
      let found = false
      for (let i = 0; i < beat1Times.length - 1; i++) {
        if (cur >= beat1Times[i] && cur < beat1Times[i+1]) {
          barStart = beat1Times[i]
          barEnd = beat1Times[i+1]
          found = true
          break
        }
      }
      if (!found) {
        const lastIdx = beat1Times.length - 1
        const interval = beat1Times[lastIdx] - (beat1Times[lastIdx - 1] ?? (beat1Times[lastIdx] - 2.0))
        const elapsed = cur - beat1Times[lastIdx]
        const barsAfter = Math.floor(elapsed / interval)
        barStart = beat1Times[lastIdx] + barsAfter * interval
        barEnd = barStart + interval
      }
    }

    const interval = barEnd - barStart
    const elapsedInBar = cur - barStart
    const beatDuration = interval / beatsPerBar
    let num = Math.floor(elapsedInBar / beatDuration) + 1
    if (num > beatsPerBar) num = beatsPerBar
    if (num < 1) num = 1
    return num
  }, [currentTrack, mainCurrentTime, beat1Times])

  const dancerCountInfo = useMemo(() => {
    if (!currentTrack || beat1Times.length === 0 || currentBeatNum === null) {
      return null
    }
    const cur = mainCurrentTime || 0
    const dance = currentTrack.danceType
    const beatsPerBar = BEATS_PER_BAR[dance] || 4

    // Calculate barIndex and beatDuration
    let barStart = beat1Times[0]
    let barEnd = beat1Times[1] ?? (barStart + 2.0)
    
    let interval = barEnd - barStart
    let barIndex = 0
    
    if (cur < beat1Times[0]) {
      const elapsed = beat1Times[0] - cur
      const barsBefore = Math.ceil(elapsed / interval)
      barStart = beat1Times[0] - barsBefore * interval
      barEnd = barStart + interval
      barIndex = -barsBefore
    } else {
      let found = false
      for (let i = 0; i < beat1Times.length - 1; i++) {
        if (cur >= beat1Times[i] && cur < beat1Times[i+1]) {
          barStart = beat1Times[i]
          barEnd = beat1Times[i+1]
          interval = barEnd - barStart
          barIndex = i
          found = true
          break
        }
      }
      if (!found) {
        const lastIdx = beat1Times.length - 1
        const elapsed = cur - beat1Times[lastIdx]
        const barsAfter = Math.floor(elapsed / interval)
        barStart = beat1Times[lastIdx] + barsAfter * interval
        barEnd = barStart + interval
        barIndex = lastIdx + barsAfter
      }
    }

    const elapsedInBar = cur - barStart
    const beatDuration = interval / beatsPerBar
    const beatProgress = (elapsedInBar % beatDuration) / beatDuration

    let pattern: string[] = []
    let weights: number[] = []
    let activeIndex = 0
    let activeLabel = ''

    if (dance === 'ChaCha') {
      pattern = ['2', '3', '4', '&', '1']
      weights = [1.0, 1.0, 0.5, 0.5, 1.0]
      if (currentBeatNum === 1) {
        activeIndex = 4
      } else if (currentBeatNum === 2) {
        activeIndex = 0
      } else if (currentBeatNum === 3) {
        activeIndex = 1
      } else if (currentBeatNum === 4) {
        if (beatProgress < 0.5) {
          activeIndex = 2
        } else {
          activeIndex = 3
        }
      }
      activeLabel = pattern[activeIndex]
    } else if (dance === 'Rumba') {
      pattern = ['2', '3', '4', '1']
      weights = [1.0, 1.0, 1.0, 1.0]
      if (currentBeatNum === 1) {
        activeIndex = 3
      } else if (currentBeatNum === 2) {
        activeIndex = 0
      } else if (currentBeatNum === 3) {
        activeIndex = 1
      } else if (currentBeatNum === 4) {
        activeIndex = 2
      }
      activeLabel = pattern[activeIndex]
    } else if (dance === 'Samba') {
      pattern = ['1', 'a', '2']
      weights = [0.75, 0.25, 1.0]
      if (currentBeatNum === 1) {
        if (beatProgress < 0.75) {
          activeIndex = 0
        } else {
          activeIndex = 1
        }
      } else if (currentBeatNum === 2) {
        activeIndex = 2
      }
      activeLabel = pattern[activeIndex]
    } else if (dance === 'Jive') {
      pattern = ['1', '2', '3', '4']
      weights = [1.0, 1.0, 1.0, 1.0]
      activeIndex = currentBeatNum - 1
      activeLabel = pattern[activeIndex]
    } else if (dance === 'Waltz' || dance === 'Viennese Waltz') {
      pattern = ['1', '2', '3']
      weights = [1.0, 1.0, 1.0]
      activeIndex = currentBeatNum - 1
      activeLabel = pattern[activeIndex]
    } else if (dance === 'Foxtrot' || dance === 'Quickstep') {
      pattern = ['1', '2', '3', '4']
      weights = [1.0, 1.0, 1.0, 1.0]
      activeIndex = currentBeatNum - 1
      activeLabel = pattern[activeIndex]
    } else if (dance === 'Paso Doble') {
      pattern = ['1', '2', '3', '4', '5', '6', '7', '8']
      weights = [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]
      const pasoBeatIndex = (((barIndex % 4) + 4) % 4) * 2 + (currentBeatNum - 1)
      activeIndex = pasoBeatIndex
      activeLabel = pattern[activeIndex]
    } else {
      pattern = Array.from({ length: beatsPerBar }, (_, i) => String(i + 1))
      weights = Array.from({ length: beatsPerBar }, () => 1.0)
      activeIndex = currentBeatNum - 1
      activeLabel = pattern[activeIndex]
    }

    return { pattern, weights, activeIndex, activeLabel }
  }, [currentTrack, mainCurrentTime, beat1Times, currentBeatNum])

  // Media Session API integration
  useEffect(() => {
    if (!('mediaSession' in navigator)) return

    if (currentTrack) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentTrack.title,
        artist: currentTrack.artist || 'DancePlayer',
        album: currentTrack.danceType,
        artwork: [
          { src: danceShapeUrl, sizes: '512x512', type: 'image/png' }
        ]
      })
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused'
    } else {
      navigator.mediaSession.metadata = null
      navigator.mediaSession.playbackState = 'none'
    }
  }, [currentTrack, isPlaying])

  useEffect(() => {
    setTapTimes([])
    if (!currentTrack) {
      setCurrentWaveform(null)
      setZoomWaveform(null)
      decodedAudioBufferRef.current = null
      return
    }

    let active = true
    async function fetchAndLoad() {
      let file = fileMap[currentTrack!.id]
      if (!file) {
        file = await getAudioFile(currentTrack!.id) ?? undefined
      }
      if (file && active) {
        void loadWaveform(file)
      }
    }

    void fetchAndLoad()

    return () => {
      active = false
    }
  }, [currentTrack?.id])

  useEffect(() => {
    if (!currentTrack) {
      if (zoomAnimationFrameRef.current) {
        cancelAnimationFrame(zoomAnimationFrameRef.current)
        zoomAnimationFrameRef.current = null
      }
      return
    }

    const draw = () => {
      const canvas = zoomCanvasRef.current
      if (!canvas) {
        zoomAnimationFrameRef.current = requestAnimationFrame(draw)
        return
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const audio = audioRef.current
      const cur = audio ? audio.currentTime : mainCurrentTime
      const duration = audio ? audio.duration : (mainDuration || currentTrack.durationSec || 1)

      // Calculate tempo (bar interval) dynamically
      let barInterval = 2.0 // default fallback
      if (currentTrack.beatPairs && currentTrack.beatPairs.length > 0) {
        const intervals = currentTrack.beatPairs.map(p => p.t2 - p.t1)
        barInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length
      } else if (currentTrack.bpm) {
        const bpb = BEATS_PER_BAR[currentTrack.danceType] || 4
        barInterval = (60 / currentTrack.bpm) * bpb
      }

      const windowDuration = zoomBarsCount * barInterval
      const tMin = cur - windowDuration / 2
      const tMax = cur + windowDuration / 2

      // Setup canvas width / height dynamically if needed (responsive)
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
        canvas.width = rect.width * dpr
        canvas.height = rect.height * dpr
        ctx.scale(dpr, dpr)
      }
      const w = rect.width
      const h = rect.height

      // Clear background
      ctx.fillStyle = '#0b1f2a'
      ctx.fillRect(0, 0, w, h)

      // Calculate beat details helper
      const getBeatInfoAtTime = (t: number) => {
        if (beat1Times.length === 0) return null
        const beatsPerBar = BEATS_PER_BAR[currentTrack.danceType] || 4

        let barStart = beat1Times[0]
        let barEnd = beat1Times[1] ?? (barStart + 2.0)
        
        if (t < beat1Times[0]) {
          const interval = (beat1Times[1] ?? (beat1Times[0] + 2.0)) - beat1Times[0]
          const elapsed = beat1Times[0] - t
          const barsBefore = Math.ceil(elapsed / interval)
          barStart = beat1Times[0] - barsBefore * interval
          barEnd = barStart + interval
        } else {
          let found = false
          for (let i = 0; i < beat1Times.length - 1; i++) {
            if (t >= beat1Times[i] && t < beat1Times[i+1]) {
              barStart = beat1Times[i]
              barEnd = beat1Times[i+1]
              found = true
              break
            }
          }
          if (!found) {
            const lastIdx = beat1Times.length - 1
            const interval = beat1Times[lastIdx] - (beat1Times[lastIdx - 1] ?? (beat1Times[lastIdx] - 2.0))
            const elapsed = t - beat1Times[lastIdx]
            const barsAfter = Math.floor(elapsed / interval)
            barStart = beat1Times[lastIdx] + barsAfter * interval
            barEnd = barStart + interval
          }
        }

        const interval = barEnd - barStart
        const elapsedInBar = t - barStart
        const beatDuration = interval / beatsPerBar
        let num = Math.floor(elapsedInBar / beatDuration) + 1
        if (num > beatsPerBar) num = beatsPerBar
        if (num < 1) num = 1
        return { num, barStart, barEnd, beatDuration, beatsPerBar }
      }

      // Update the DOM Beat Indicator in perfect sync
      const activeBeat = getBeatInfoAtTime(cur)
      if (zoomBeatPillRef.current) {
        if (activeBeat) {
          zoomBeatPillRef.current.innerText = `Beat ${activeBeat.num}`
          if (activeBeat.num === 1) {
            zoomBeatPillRef.current.className = 'zoom-beat-pill beat-one'
          } else {
            zoomBeatPillRef.current.className = 'zoom-beat-pill'
          }
          zoomBeatPillRef.current.style.display = 'block'
        } else {
          zoomBeatPillRef.current.style.display = 'none'
        }
      }

      // Update the Dancer Count Span Elements in perfect sync
      if (activeBeat && dancerCountSpansRef.current.length > 0) {
        const curBeatNum = activeBeat.num
        const { barStart, barEnd, beatDuration } = activeBeat
        const elapsedInBar = cur - barStart
        const beatProgress = (elapsedInBar / beatDuration) - (curBeatNum - 1)
        const dance = currentTrack.danceType

        let activeIdx = -1

        if (dance === 'ChaCha') {
          if (curBeatNum === 1) {
            activeIdx = 4
          } else if (curBeatNum === 2) {
            activeIdx = 0
          } else if (curBeatNum === 3) {
            activeIdx = 1
          } else if (curBeatNum === 4) {
            if (beatProgress < 0.5) {
              activeIdx = 2
            } else {
              activeIdx = 3
            }
          }
        } else if (dance === 'Rumba') {
          if (curBeatNum === 1) {
            activeIdx = 3
          } else if (curBeatNum === 2) {
            activeIdx = 0
          } else if (curBeatNum === 3) {
            activeIdx = 1
          } else if (curBeatNum === 4) {
            activeIdx = 2
          }
        } else if (dance === 'Samba') {
          if (curBeatNum === 1) {
            if (beatProgress < 0.75) {
              activeIdx = 0
            } else {
              activeIdx = 1
            }
          } else if (curBeatNum === 2) {
            activeIdx = 2
          }
        } else if (dance === 'Jive') {
          activeIdx = curBeatNum - 1
        } else if (dance === 'Waltz' || dance === 'Viennese Waltz') {
          activeIdx = curBeatNum - 1
        } else if (dance === 'Foxtrot' || dance === 'Quickstep') {
          activeIdx = curBeatNum - 1
        } else if (dance === 'Paso Doble') {
          const barIndex = Math.round((barStart - beat1Times[0]) / (barEnd - barStart))
          activeIdx = (((barIndex % 4) + 4) % 4) * 2 + (curBeatNum - 1)
        } else {
          activeIdx = curBeatNum - 1
        }

        dancerCountSpansRef.current.forEach((span, idx) => {
          if (span) {
            const isActive = idx === activeIdx
            span.style.color = isActive ? '#ff7043' : '#6f8a99'
            span.style.textShadow = isActive ? '0 0 6px rgba(255, 112, 67, 0.4)' : 'none'
            span.style.borderBottom = '2px solid ' + (isActive ? '#ff7043' : 'transparent')
            
            const nextBar = span.nextSibling as HTMLDivElement
            if (nextBar) {
              nextBar.style.background = isActive ? '#ff7043' : 'rgba(255,255,255,0.1)'
              nextBar.style.opacity = isActive ? '1.0' : '0.4'
            }
          }
        })
      }

      // Draw colored background beat rectangles
      if (beat1Times.length > 0) {
        // Find first bar start prior to tMin
        let tempT = tMin - barInterval * 2
        // Limit iterations in case of extremely small tempo errors
        let limit = 0
        while (tempT <= tMax && limit < 100) {
          limit++
          const info = getBeatInfoAtTime(tempT)
          if (info) {
            const { barStart, barEnd, beatDuration, beatsPerBar } = info
            for (let b = 0; b < beatsPerBar; b++) {
              const bStart = barStart + b * beatDuration
              const bEnd = bStart + beatDuration
              
              if (bEnd >= tMin && bStart <= tMax) {
                const x1 = Math.max(0, ((bStart - tMin) / windowDuration) * w)
                const x2 = Math.min(w, ((bEnd - tMin) / windowDuration) * w)
                
                // Color mapping: Beat 1 is soft coral/orange, others are soft green/teal
                if (b === 0) {
                  ctx.fillStyle = 'rgba(255, 112, 67, 0.12)'
                } else if (b % 2 === 1) {
                  ctx.fillStyle = 'rgba(76, 216, 176, 0.05)'
                } else {
                  ctx.fillStyle = 'rgba(76, 216, 176, 0.08)'
                }
                ctx.fillRect(x1, 0, x2 - x1, h)
              }
            }
            // Move to next bar
            tempT = barEnd + 0.01
          } else {
            tempT += barInterval
          }
        }
      }

      // Draw horizontal baseline
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, h / 2)
      ctx.lineTo(w, h / 2)
      ctx.stroke()

      // Draw high definition waveform from zoomWaveform
      if (zoomWaveform) {
        // Render columns
        const colWidth = 2
        const gap = 1
        const step = colWidth + gap
        const numCols = Math.ceil(w / step)

        for (let col = 0; col < numCols; col++) {
          const colX = col * step
          // Find time at this x coordinate
          const t = tMin + (colX / w) * windowDuration
          if (t >= 0 && t <= duration) {
            // Interpolate smoothly between adjacent bins to prevent flickering
            const sampleIdx = (t / duration) * (zoomWaveform.length - 1)
            const idxL = Math.floor(sampleIdx)
            const idxR = Math.ceil(sampleIdx)
            const weight = sampleIdx - idxL
            const val = (1 - weight) * (zoomWaveform[idxL] || 0) + weight * (zoomWaveform[idxR] || 0)

            const barH = Math.min(1.0, val * 2.0) * (h - 10)
            const y = (h - barH) / 2
            
            // Draw active/inactive color based on if it's past cur
            if (t <= cur) {
              ctx.fillStyle = '#4cd8b0' // active
            } else {
              ctx.fillStyle = 'rgba(76, 216, 176, 0.35)' // preview/inactive
            }
            ctx.fillRect(colX, y, colWidth, barH)
          }
        }
      }

      // Draw Beat 1 grid lines
      beat1Times.forEach((time) => {
        if (time >= tMin && time <= tMax) {
          const x = ((time - tMin) / windowDuration) * w
          const isRegistered = currentTrack.beatPairs?.some(
            pair => Math.abs(time - pair.t1) < 0.5 || Math.abs(time - pair.t2) < 0.5
          ) || (currentTrack.lateBeatSec !== undefined && Math.abs(time - currentTrack.lateBeatSec) < 0.5)

          ctx.strokeStyle = isRegistered ? '#ffd56b' : 'rgba(255, 255, 255, 0.4)'
          ctx.lineWidth = isRegistered ? 2 : 1
          ctx.beginPath()
          ctx.moveTo(x, 0)
          ctx.lineTo(x, h)
          ctx.stroke()

          // Draw small text label for the beat
          ctx.fillStyle = isRegistered ? '#ffd56b' : '#a0b2bd'
          ctx.font = '9px sans-serif'
          ctx.fillText(`Beat 1`, x + 4, 15)
        }
      })

      // Draw Center Playhead line
      ctx.strokeStyle = '#ff7043'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(w / 2, 0)
      ctx.lineTo(w / 2, h)
      ctx.stroke()

      // Small playhead marker triangle at top
      ctx.fillStyle = '#ff7043'
      ctx.beginPath()
      ctx.moveTo(w / 2 - 6, 0)
      ctx.lineTo(w / 2 + 6, 0)
      ctx.lineTo(w / 2, 8)
      ctx.closePath()
      ctx.fill()

      zoomAnimationFrameRef.current = requestAnimationFrame(draw)
    }

    zoomAnimationFrameRef.current = requestAnimationFrame(draw)

    return () => {
      if (zoomAnimationFrameRef.current) {
        cancelAnimationFrame(zoomAnimationFrameRef.current)
        zoomAnimationFrameRef.current = null
      }
    }
  }, [currentTrack, beat1Times, zoomBarsCount, mainCurrentTime, mainDuration])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return

    const handlePlay = () => {
      const audio = audioRef.current
      if (audio) void audio.play().catch(() => null)
    }
    const handlePause = () => {
      const audio = audioRef.current
      if (audio) audio.pause()
    }
    const handleNext = () => {
      nextSong()
    }
    const handlePrev = () => {
      repeatSong()
    }

    navigator.mediaSession.setActionHandler('play', handlePlay)
    navigator.mediaSession.setActionHandler('pause', handlePause)
    navigator.mediaSession.setActionHandler('nexttrack', handleNext)
    navigator.mediaSession.setActionHandler('previoustrack', handlePrev)

    return () => {
      navigator.mediaSession.setActionHandler('play', null)
      navigator.mediaSession.setActionHandler('pause', null)
      navigator.mediaSession.setActionHandler('nexttrack', null)
      navigator.mediaSession.setActionHandler('previoustrack', null)
    }
  }, [playableEntries, activeEntryId])

  // Keyboard remote control shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeTag = document.activeElement?.tagName.toLowerCase()
      if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') {
        return
      }

      if (e.key === 'Space' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        togglePlayPause()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        nextSong()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        repeatSong()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        seekBy(15)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        seekBy(-15)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeEntryId, playableEntries, isPlaying])

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

    // Update ratings for existing duplicate files if they have POPM rating tags in file
    const duplicateFiles = fileHashes.filter(({ file, hash }) => {
      return tracks.some((t) => {
        if (hash && t.hash) {
          return t.hash === hash
        }
        const nameNoExt = file.name.replace(/\.[^.]+$/, '').trim().toLowerCase()
        return t.title.trim().toLowerCase() === nameNoExt
      })
    })

    if (duplicateFiles.length > 0) {
      // Parse duplicate files asynchronously to check if ratings need updating
      void Promise.all(duplicateFiles.map(async ({ file, hash }) => {
        try {
          const metadata = await mm.parseBlob(file)
          let initialRating = 0
          let popmFound = false

          // 1. Prioritize native ID3v2 structures for POPM frame (desktop helper app values)
          const nativeFormats = ['ID3v2.3', 'ID3v2.4', 'ID3v2.2']
          for (const format of nativeFormats) {
            const tags = metadata.native[format]
            if (tags) {
              const popmTag = tags.find(t => t.id === 'POPM')
              if (popmTag && popmTag.value) {
                let rawRating = 0
                if (typeof popmTag.value === 'object' && popmTag.value !== null) {
                  rawRating = (popmTag.value as any).rating ?? 0
                } else if (typeof popmTag.value === 'number') {
                  rawRating = popmTag.value
                }

                if (rawRating > 0) {
                  if (rawRating <= 63) initialRating = 1
                  else if (rawRating <= 127) initialRating = 2
                  else if (rawRating <= 195) initialRating = 3
                  else if (rawRating <= 254) initialRating = 4
                  else if (rawRating === 255) initialRating = 5
                  popmFound = true
                  break
                }
              }
            }
          }

          // 2. Fallback: Check common rating mapping
          if (!popmFound) {
            const ratings = metadata.common.rating
            if (ratings && ratings.length > 0) {
              const r = ratings[0].rating
              if (r > 1) {
                initialRating = Math.round((r / 255) * 5)
              } else {
                initialRating = Math.round(r * 5)
              }
            }
          }

          if (initialRating > 0) {
            setTracks(prev => prev.map(t => {
              const matches = (hash && t.hash === hash) || (t.filename === file.name)
              if (matches && t.qualityRating !== initialRating) {
                return { ...t, qualityRating: initialRating }
              }
              return t
            }))
          }
        } catch (err) {
          console.warn('Failed to parse duplicate file metadata for rating update:', file.name, err)
        }
      })).then(() => {
        setStatus(`Staged library ratings updated from selected files.`)
      })
    }

    if (!newFiles.length) {
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
        console.log(`[Import] File: ${file.name}`, {
          common: metadata.common,
          native: metadata.native
        })
        let popmFound = false

        // 1. Prioritize native ID3v2 structures for POPM frame (desktop helper app values)
        const nativeFormats = ['ID3v2.3', 'ID3v2.4', 'ID3v2.2']
        for (const format of nativeFormats) {
          const tags = metadata.native[format]
          if (tags) {
            const popmTag = tags.find(t => t.id === 'POPM')
            if (popmTag && popmTag.value) {
              let rawRating = 0
              if (typeof popmTag.value === 'object' && popmTag.value !== null) {
                rawRating = (popmTag.value as any).rating ?? 0
              } else if (typeof popmTag.value === 'number') {
                rawRating = popmTag.value
              }

              if (rawRating > 0) {
                if (rawRating <= 63) initialRating = 1
                else if (rawRating <= 127) initialRating = 2
                else if (rawRating <= 195) initialRating = 3
                else if (rawRating <= 254) initialRating = 4
                else if (rawRating === 255) initialRating = 5
                popmFound = true
                break
              }
            }
          }
        }

        // 2. Fallback: Check common rating mapping
        if (!popmFound) {
          const ratings = metadata.common.rating
          if (ratings && ratings.length > 0) {
            const r = ratings[0].rating
            if (r > 1) {
              initialRating = Math.round((r / 255) * 5)
            } else {
              initialRating = Math.round(r * 5)
            }
          }
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
        const id = window.setTimeout(() => { speak(String(t)) }, (dur - t) * 1000)
        countdownSpeechTimeoutsRef.current.push(id)
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
    // Clear countdown speech timeouts
    countdownSpeechTimeoutsRef.current.forEach((t) => window.clearTimeout(t))
    countdownSpeechTimeoutsRef.current = []
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel()
    }
    setBreakSecondsLeft(null)
    setBreakInfo(null)
    setTrackProgress(0)
  }

  async function loadWaveform(file: File) {
    try {
      setCurrentWaveform(null)
      setZoomWaveform(null)
      decodedAudioBufferRef.current = null
      
      const arrayBuffer = await file.arrayBuffer()
      const offlineCtx = new OfflineAudioContext(1, 44100, 44100)
      const audioBuffer = await offlineCtx.decodeAudioData(arrayBuffer)
      decodedAudioBufferRef.current = audioBuffer
      
      const rawData = audioBuffer.getChannelData(0)
      const len = rawData.length
      
      // Step stride of 16 reduces main thread block by 16x
      const stride = 16

      // 1. Normal Waveform (180 samples)
      const samples = 180
      const blockSize = Math.floor(len / samples)
      const peaks: number[] = []
      for (let i = 0; i < samples; i++) {
        const blockStart = blockSize * i
        const limit = Math.min(blockStart + blockSize, len)
        let sum = 0
        let count = 0
        for (let j = blockStart; j < limit; j += stride) {
          sum += Math.abs(rawData[j])
          count++
        }
        peaks.push(sum / (count || 1))
      }
      const max = Math.max(...peaks)
      const normalized = peaks.map(p => max > 0 ? Math.pow(p / max, 1.8) : 0)
      setCurrentWaveform(normalized)

      // 2. High Resolution Zoom Waveform (4000 samples)
      const zoomSamples = 4000
      const zoomBlockSize = Math.floor(len / zoomSamples)
      const zoomPeaks: number[] = []
      for (let i = 0; i < zoomSamples; i++) {
        const blockStart = zoomBlockSize * i
        const limit = Math.min(blockStart + zoomBlockSize, len)
        let sum = 0
        let count = 0
        for (let j = blockStart; j < limit; j += stride) {
          sum += Math.abs(rawData[j])
          count++
        }
        zoomPeaks.push(sum / (count || 1))
      }
      const zoomMax = Math.max(...zoomPeaks)
      const zoomNormalized = zoomPeaks.map(p => zoomMax > 0 ? Math.pow(p / zoomMax, 1.8) : 0)
      setZoomWaveform(zoomNormalized)
    } catch (err) {
      console.error('Failed to generate waveform:', err)
      setCurrentWaveform(null)
      setZoomWaveform(null)
      decodedAudioBufferRef.current = null
    }
  }

  async function playEntryByIndex(index: number) {
    clearPlaybackTimers()
    const entry = playableEntries[index]
    if (!entry) {
      if (settings.repeatPlaylist && playableEntries.length > 0) {
        setStatus('Playlist finished. Repeating from start.')
        void playEntryByIndex(0)
      } else {
        setActiveEntryId(null)
        setStatus('Playlist finished.')
      }
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
          const id = window.setTimeout(() => { speak(String(t)) }, delay)
          countdownSpeechTimeoutsRef.current.push(id)
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

    void loadWaveform(file)

    if (sessionRuleRef.current.announcementEnabled) {
      const phrase = `Next ${track.danceType}`   // always English
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

  function seekBy(deltaSec: number) {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = Math.max(0, audio.currentTime + deltaSec)
  }

  function applySpeedDelta(delta: number) {
    setSettings((prev) => ({ ...prev, speedPct: clampSpeed(prev.speedPct + delta) }))
  }

  function findWavePeak(t: number): number {
    const audioBuffer = decodedAudioBufferRef.current
    if (!audioBuffer) {
      const latencySec = (settings.tapLatencyMs ?? 100) / 1000
      return t - latencySec
    }
    
    try {
      const channelData = audioBuffer.getChannelData(0)
      const sampleRate = audioBuffer.sampleRate
      
      // Look in a 400ms window: t - 350ms to t + 50ms
      const startSec = t - 0.35
      const endSec = t + 0.05
      
      const startSample = Math.max(0, Math.floor(startSec * sampleRate))
      const endSample = Math.min(channelData.length - 1, Math.floor(endSec * sampleRate))
      
      const chunkSize = Math.floor(0.005 * sampleRate) // 5ms chunks
      let maxEnergy = -1
      let peakTime = t - 0.15 // fallback
      
      for (let i = startSample; i < endSample; i += chunkSize) {
        let sum = 0
        const count = Math.min(chunkSize, endSample - i)
        if (count <= 0) break
        
        for (let j = 0; j < count; j++) {
          sum += Math.abs(channelData[i + j])
        }
        const avg = sum / count
        if (avg > maxEnergy) {
          maxEnergy = avg
          peakTime = (i + count / 2) / sampleRate
        }
      }
      
      console.log(`Snapped tap time ${t.toFixed(3)}s to peak at ${peakTime.toFixed(3)}s (diff: ${((t - peakTime)*1000).toFixed(0)}ms)`)
      return peakTime
    } catch (err) {
      console.error('Failed to find wave peak:', err)
      const latencySec = (settings.tapLatencyMs ?? 100) / 1000
      return t - latencySec
    }
  }

  function handleTapBeat1() {
    if (!currentTrack) return
    const audio = audioRef.current
    if (!audio) return
    const curTime = audio.currentTime

    const hasNoPairs = !currentTrack.beatPairs || currentTrack.beatPairs.length === 0

    if (hasNoPairs) {
      const lastTap = tapTimes[tapTimes.length - 1]
      const isSecondOfPair = lastTap !== undefined && (curTime - lastTap) < 5.0

      if (isSecondOfPair) {
        const t1Snapped = findWavePeak(lastTap)
        const t2Snapped = findWavePeak(curTime)
        const newPair: BeatPair = {
          t1: t1Snapped,
          t2: t2Snapped
        }
        setTapTimes([])
        updateTrack(currentTrack.id, {
          beatPairs: [newPair]
        })
        const pairInterval = newPair.t2 - newPair.t1
        const calculatedBpm = Math.round(60 / pairInterval)
        setStatus(`Beat Pair registered! Local tempo: ${calculatedBpm} Bars/Min (${Math.round(calculatedBpm * BEATS_PER_BAR[currentTrack.danceType])} BPM). Now move to a later stage of the song and tap once to align.`)
      } else {
        setTapTimes([curTime])
        setStatus("First tap of Beat 1 pair recorded. Tap on the next Beat 1 to define the initial tempo.")
      }
    } else {
      // 3rd Tap: Align Late Beat 1
      const lateTime = findWavePeak(curTime)
      updateTrack(currentTrack.id, {
        lateBeatSec: lateTime
      })
      setStatus(`Late Beat 1 aligned at ${formatTime(lateTime)}. Grid calibrated and locked!`)
    }
  }

  function handleResetBeats() {
    if (!currentTrack) return
    setTapTimes([])
    updateTrack(currentTrack.id, {
      beatPairs: [],
      lateBeatSec: undefined,
      intervalOffsetSec: undefined
    })
    setStatus('Beat alignment reset.')
  }

  function fineTuneInterval(offsetMs: number) {
    if (!currentTrack) return
    const currentOffset = currentTrack.intervalOffsetSec || 0
    updateTrack(currentTrack.id, {
      intervalOffsetSec: currentOffset + offsetMs / 1000
    })
  }



  return (
    <div className="app-shell">
      <header className="hero" style={{ display: 'flex', alignItems: 'center', gap: '20px', flexWrap: 'wrap' }}>
        <img src={danceShapeUrl} alt="Dance Shape" style={{ height: '75px', width: 'auto', borderRadius: '12px', filter: 'drop-shadow(0 4px 6px rgba(0,0,0,0.3))' }} />
        <div style={{ flex: 1, minWidth: '200px' }}>
          <p className="kicker">DancePlayer PWA</p>
          <h1 style={{ margin: '4px 0 8px' }}>Dance Player</h1>
          <p className="subtitle">
            Local-first dance playback with smart breaks and pitch control.
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', background: 'rgba(255,255,255,0.06)', padding: '4px 12px', borderRadius: '20px', fontSize: '0.85rem', flexWrap: 'wrap' }}>
                    <span style={{ opacity: 0.85, fontWeight: 500 }}>Select Rating:</span>
                    {[5, 4, 3, 2, 1].map((r) => {
                      const matching = visibleTracks.filter((t) => (t.qualityRating ?? 0) === r)
                      if (matching.length === 0) return null
                      const checked = matching.every((t) => selectedTrackIds.has(t.id))
                      return (
                        <label key={r} style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', userSelect: 'none', margin: 0 }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setSelectedTrackIds((prev) => {
                                const next = new Set(prev)
                                if (checked) {
                                  matching.forEach((t) => next.delete(t.id))
                                } else {
                                  matching.forEach((t) => next.add(t.id))
                                }
                                return next
                              })
                            }}
                            style={{ margin: 0, width: '14px', height: '14px', cursor: 'pointer' }}
                          />
                          <span>{r}★ ({matching.length})</span>
                        </label>
                      )
                    })}
                  </div>
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span className="track-title">{track.title}</span>
                      <span className="track-stars" style={{ color: 'var(--sun)', fontSize: '0.95rem', userSelect: 'none', letterSpacing: '0.5px' }}>
                        {'★'.repeat(track.qualityRating || 0) + '☆'.repeat(5 - (track.qualityRating || 0))}
                      </span>
                    </div>
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
                        <span className="qe-title" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                          {cleanDisplayTitle(t.title)}
                          {t.beatPairs && t.beatPairs.length > 0 && (
                            <span title="Beat alignment grid added" style={{ fontSize: '0.85rem', color: '#ff7043', cursor: 'default' }}>🥁</span>
                          )}
                        </span>
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
                                <span className="qe-title" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                                  {cleanDisplayTitle(t.title)}
                                  {t.beatPairs && t.beatPairs.length > 0 && (
                                    <span title="Beat alignment grid added" style={{ fontSize: '0.85rem', color: '#ff7043', cursor: 'default' }}>🥁</span>
                                  )}
                                </span>
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
                <div className="now-playing-strip" style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', padding: '10px 12px', margin: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div className="now-playing-info">
                    <span className="now-playing-title" style={{ color: '#fff', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                      {cleanDisplayTitle(currentTrack.title)}
                      {currentTrack.beatPairs && currentTrack.beatPairs.length > 0 && (
                        <span title="Beat alignment grid added" style={{ fontSize: '0.85rem', color: '#ff7043', cursor: 'default' }}>🥁</span>
                      )}
                    </span>
                    {currentTrack.artist && <span className="now-playing-artist" style={{ color: '#a0b2bd' }}>{currentTrack.artist}</span>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {isPlaying && currentBeatNum !== null && (
                      <span
                        key={currentBeatNum}
                        style={{
                          background: currentBeatNum === 1 ? '#ff7043' : '#4cd8b0',
                          color: '#fff',
                          fontSize: '0.82rem',
                          fontWeight: 'bold',
                          padding: '3px 8px',
                          borderRadius: '6px',
                          boxShadow: '0 2px 6px rgba(0,0,0,0.25)',
                          animation: 'beat-pulse 0.15s ease-out'
                        }}
                      >
                        Beat {currentBeatNum}
                      </span>
                    )}
                    <span className="dance-badge now-playing-badge" style={{ background: DANCE_COLORS[currentTrack.danceType], margin: 0 }}>
                      {currentTrack.danceType}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="now-playing-strip now-playing-empty" style={{ background: 'rgba(255,255,255,0.03)', border: '1px dashed rgba(255,255,255,0.1)', color: '#8a9aa3', display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '12px' }}>
                  No track playing
                </div>
              )}

              {/* Dancer's Count Display */}
              {currentTrack && dancerCountInfo && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: 'rgba(0,0,0,0.2)',
                  padding: '6px 12px',
                  borderRadius: '8px',
                  border: '1px solid rgba(255,255,255,0.05)',
                  fontSize: '0.8rem',
                  marginTop: '2px',
                  height: '38px', // slightly taller to host duration bars
                  boxSizing: 'border-box'
                }}>
                  <span style={{ color: '#a0b2bd', marginRight: '8px' }}>Dancer Count:</span>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flex: 1, justifyContent: 'flex-end', maxWidth: '300px' }}>
                    {dancerCountInfo.pattern.map((tok, idx) => {
                      const isActive = idx === dancerCountInfo.activeIndex;
                      const weight = dancerCountInfo.weights[idx] || 1.0;
                      return (
                        <div
                          key={idx}
                          style={{
                            flex: weight,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: '2px'
                          }}
                        >
                          <span
                            ref={el => { dancerCountSpansRef.current[idx] = el; }}
                            style={{
                              fontWeight: 'bold',
                              color: isActive ? '#ff7043' : '#6f8a99',
                              fontSize: '0.9rem',
                              textShadow: isActive ? '0 0 6px rgba(255, 112, 67, 0.4)' : 'none',
                              transition: 'all 0.08s ease',
                              padding: '2px 4px',
                              borderBottom: '2px solid ' + (isActive ? '#ff7043' : 'transparent'),
                              boxSizing: 'border-box',
                              display: 'inline-block',
                              textAlign: 'center',
                              width: '100%',
                              minWidth: '16px'
                            }}
                          >
                            {tok}
                          </span>
                          <div style={{
                            height: '3px',
                            background: isActive ? '#ff7043' : 'rgba(255,255,255,0.1)',
                            width: '85%',
                            borderRadius: '1.5px',
                            opacity: isActive ? 1.0 : 0.4,
                            transition: 'all 0.08s ease'
                          }} />
                        </div>
                      )
                    })}
                  </div>
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
                    <div className="cue-bar-wrap" style={{ margin: '4px 0 24px' }}>
                      <div className="cue-bar-container">
                        {!currentWaveform && (
                          <div className="cue-bar" style={{ background: 'rgba(255,255,255,0.15)', height: '8px', borderRadius: '4px', position: 'relative', width: '100%' }}>
                            <div className="cue-bar-active" style={{ position: 'absolute', height: '100%', left: `${cuePos}%`, width: `${endPos - cuePos}%`, background: '#4cd8b0', opacity: 0.3 }} />
                            <div className="cue-bar-progress" style={{ position: 'absolute', height: '100%', left: 0, width: `${fullPct}%`, background: '#4cd8b0', borderRadius: '4px' }} />
                            <div className="cue-marker cue-marker-start" style={{ position: 'absolute', left: `${cuePos}%`, background: '#fff', width: '2px', height: '12px', top: '-2px' }} title={`Cue: ${fmtSec(cueStart)}`} />
                            <div className="cue-marker cue-marker-end" style={{ position: 'absolute', left: `${endPos}%`, background: '#fff', width: '2px', height: '12px', top: '-2px' }} title={`End: ${fmtSec(limitTime)}`} />
                          </div>
                        )}
                        {currentWaveform && (
                          <div className="waveform-wrapper" style={{
                            position: 'relative',
                            width: '100%',
                            height: '24px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '1.5px',
                            pointerEvents: 'none'
                          }}>
                            {currentWaveform.map((val, idx) => {
                              const barPct = (idx / currentWaveform.length) * 100
                              const isActive = barPct <= fullPct
                              const isWdsfActive = barPct >= cuePos && barPct <= endPos

                              let barColor = 'rgba(255, 255, 255, 0.25)'
                              if (isActive) {
                                barColor = '#4cd8b0'
                              } else if (isWdsfActive) {
                                barColor = 'rgba(76, 216, 176, 0.35)'
                              }

                              return (
                                <div
                                  key={idx}
                                  style={{
                                    flex: 1,
                                    height: `${Math.max(15, val * 100)}%`,
                                    background: barColor,
                                    borderRadius: '1px',
                                    transition: 'background-color 0.1s'
                                  }}
                                />
                              )
                            })}
                            <div className="cue-marker cue-marker-start" style={{ position: 'absolute', left: `${cuePos}%`, background: '#fff', width: '2px', height: '28px', top: '-2px', zIndex: 5 }} title={`Cue: ${fmtSec(cueStart)}`} />
                            <div className="cue-marker cue-marker-end" style={{ position: 'absolute', left: `${endPos}%`, background: '#fff', width: '2px', height: '28px', top: '-2px', zIndex: 5 }} title={`End: ${fmtSec(limitTime)}`} />
                            {beat1Times.map((time, idx) => {
                              const pct = (time / dur) * 100
                              const isRegistered = currentTrack.beatPairs?.some(
                                pair => Math.abs(time - pair.t1) < 0.5 || Math.abs(time - pair.t2) < 0.5
                              ) || (currentTrack.lateBeatSec !== undefined && Math.abs(time - currentTrack.lateBeatSec) < 0.5)
                              if (!isRegistered) return null
                              return (
                                <div
                                  key={`beat1-${idx}`}
                                  style={{
                                    position: 'absolute',
                                    left: `${pct}%`,
                                    bottom: 0,
                                    height: '8px',
                                    width: '1px',
                                    background: '#ffd56b',
                                    zIndex: 4
                                  }}
                                  title={`Beat 1: ${fmtSec(time)} (Registered Click)`}
                                />
                              )
                            })}
                          </div>
                        )}
                        <input
                          type="range"
                          className="cue-bar-slider"
                          min={0}
                          max={dur}
                          step={0.1}
                          value={cur}
                          onChange={(e) => {
                            const val = Number(e.target.value)
                            const audio = audioRef.current
                            if (audio) {
                              audio.currentTime = val
                              setMainCurrentTime(val)
                            }
                          }}
                        />
                        {/* Playhead pin below the waveform */}
                        <div
                          className="cue-playhead"
                          style={{
                            position: 'absolute',
                            left: `${fullPct}%`,
                            top: '27px',
                            transform: 'translateX(-50%)',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            pointerEvents: 'none',
                            zIndex: 15
                          }}
                        >
                          <div style={{
                            width: 0,
                            height: 0,
                            borderLeft: '3px solid transparent',
                            borderRight: '3px solid transparent',
                            borderBottom: '4px solid #ffffff',
                          }} />
                          <div style={{
                            width: '6px',
                            height: '6px',
                            borderRadius: '50%',
                            background: '#ffffff',
                            boxShadow: '0 2px 4px rgba(0,0,0,0.4)',
                            marginTop: '-1px'
                          }} />
                        </div>
                      </div>
                      <div className="cue-bar-labels" style={{ display: 'flex', justifyContent: 'space-between', color: '#a0b2bd', fontSize: '0.75rem', marginTop: '12px' }}>
                        <span>▶ {fmtSec(cur)} / {fmtSec(limitTime)} (Cue: {fmtSec(cueStart)})</span>
                        <span style={{ fontWeight: 'bold', color: '#4cd8b0' }}>-{fmtSec(timeLeft)} left</span>
                      </div>

                      <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                        <button
                          type="button"
                          onClick={() => {
                            const audio = audioRef.current
                            if (audio) {
                              const cue = currentTrack.cueStartSec || 0
                              audio.currentTime = cue
                              setMainCurrentTime(cue)
                            }
                          }}
                          style={{
                            flex: 1,
                            background: 'rgba(255,255,255,0.08)',
                            color: '#fff',
                            border: '1px solid rgba(255,255,255,0.15)',
                            borderRadius: '6px',
                            padding: '4px 8px',
                            cursor: 'pointer',
                            fontSize: '0.72rem'
                          }}
                        >
                          ⏮ Jump Start
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const audio = audioRef.current
                            if (audio) {
                              const mid = dur * 0.5
                              audio.currentTime = mid
                              setMainCurrentTime(mid)
                            }
                          }}
                          style={{
                            flex: 1,
                            background: 'rgba(255,255,255,0.08)',
                            color: '#fff',
                            border: '1px solid rgba(255,255,255,0.15)',
                            borderRadius: '6px',
                            padding: '4px 8px',
                            cursor: 'pointer',
                            fontSize: '0.72rem'
                          }}
                        >
                          ⏯ Jump Mid
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const audio = audioRef.current
                            if (audio) {
                              const end = dur * 0.9
                              audio.currentTime = end
                              setMainCurrentTime(end)
                            }
                          }}
                          style={{
                            flex: 1,
                            background: 'rgba(255,255,255,0.08)',
                            color: '#fff',
                            border: '1px solid rgba(255,255,255,0.15)',
                            borderRadius: '6px',
                            padding: '4px 8px',
                            cursor: 'pointer',
                            fontSize: '0.72rem'
                          }}
                        >
                          ⏭ Jump End
                        </button>
                      </div>
                    </div>
                  )
                } else {
                  // In untimed mode, progress runs from 0 to dur (full song)
                  const pct = Math.min(100, Math.max(0, (cur / dur) * 100))
                  const timeLeft = Math.max(0, dur - cur)

                  return (
                    <div className="cue-bar-wrap" style={{ margin: '4px 0 24px' }}>
                      <div className="cue-bar-container">
                        {!currentWaveform && (
                          <div className="cue-bar" style={{ background: 'rgba(255,255,255,0.15)', height: '8px', borderRadius: '4px', position: 'relative', overflow: 'hidden', width: '100%' }}>
                            <div className="cue-bar-progress" style={{ position: 'absolute', height: '100%', left: 0, width: `${pct}%`, background: '#4cd8b0' }} />
                          </div>
                        )}
                        {currentWaveform && (
                          <div className="waveform-wrapper" style={{
                            position: 'relative',
                            width: '100%',
                            height: '24px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '1.5px',
                            pointerEvents: 'none'
                          }}>
                            {currentWaveform.map((val, idx) => {
                              const barPct = (idx / currentWaveform.length) * 100
                              const isActive = barPct <= pct

                              let barColor = 'rgba(255, 255, 255, 0.25)'
                              if (isActive) {
                                barColor = '#4cd8b0'
                              }

                              return (
                                <div
                                  key={idx}
                                  style={{
                                    flex: 1,
                                    height: `${Math.max(15, val * 100)}%`,
                                    background: barColor,
                                    borderRadius: '1px',
                                    transition: 'background-color 0.1s'
                                  }}
                                />
                              )
                            })}
                            {beat1Times.map((time, idx) => {
                              const pct = (time / dur) * 100
                              const isRegistered = currentTrack.beatPairs?.some(
                                pair => Math.abs(time - pair.t1) < 0.001 || Math.abs(time - pair.t2) < 0.001
                              )
                              if (!isRegistered) return null
                              return (
                                <div
                                  key={`beat1-${idx}`}
                                  style={{
                                    position: 'absolute',
                                    left: `${pct}%`,
                                    bottom: 0,
                                    height: '8px',
                                    width: '1px',
                                    background: '#ffd56b',
                                    zIndex: 4
                                  }}
                                  title={`Beat 1: ${fmtSec(time)} (Registered Click)`}
                                />
                              )
                            })}
                          </div>
                        )}
                        <input
                          type="range"
                          className="cue-bar-slider"
                          min={0}
                          max={dur}
                          step={0.1}
                          value={cur}
                          onChange={(e) => {
                            const val = Number(e.target.value)
                            const audio = audioRef.current
                            if (audio) {
                              audio.currentTime = val
                              setMainCurrentTime(val)
                            }
                          }}
                        />
                        {/* Playhead pin below the waveform */}
                        <div
                          className="cue-playhead"
                          style={{
                            position: 'absolute',
                            left: `${pct}%`,
                            top: '27px',
                            transform: 'translateX(-50%)',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            pointerEvents: 'none',
                            zIndex: 15
                          }}
                        >
                          <div style={{
                            width: 0,
                            height: 0,
                            borderLeft: '3px solid transparent',
                            borderRight: '3px solid transparent',
                            borderBottom: '4px solid #ffffff',
                          }} />
                          <div style={{
                            width: '6px',
                            height: '6px',
                            borderRadius: '50%',
                            background: '#ffffff',
                            boxShadow: '0 2px 4px rgba(0,0,0,0.4)',
                            marginTop: '-1px'
                          }} />
                        </div>
                      </div>
                      <div className="cue-bar-labels" style={{ display: 'flex', justifyContent: 'space-between', color: '#a0b2bd', fontSize: '0.75rem', marginTop: '12px' }}>
                        <span>▶ {fmtSec(cur)} / {fmtSec(dur)}</span>
                        <span style={{ fontWeight: 'bold', color: '#4cd8b0' }}>-{fmtSec(timeLeft)} left</span>
                      </div>

                      <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                        <button
                          type="button"
                          onClick={() => {
                            const audio = audioRef.current
                            if (audio) {
                              const cue = currentTrack.cueStartSec || 0
                              audio.currentTime = cue
                              setMainCurrentTime(cue)
                            }
                          }}
                          style={{
                            flex: 1,
                            background: 'rgba(255,255,255,0.08)',
                            color: '#fff',
                            border: '1px solid rgba(255,255,255,0.15)',
                            borderRadius: '6px',
                            padding: '4px 8px',
                            cursor: 'pointer',
                            fontSize: '0.72rem'
                          }}
                        >
                          ⏮ Jump Start
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const audio = audioRef.current
                            if (audio) {
                              const mid = dur * 0.5
                              audio.currentTime = mid
                              setMainCurrentTime(mid)
                            }
                          }}
                          style={{
                            flex: 1,
                            background: 'rgba(255,255,255,0.08)',
                            color: '#fff',
                            border: '1px solid rgba(255,255,255,0.15)',
                            borderRadius: '6px',
                            padding: '4px 8px',
                            cursor: 'pointer',
                            fontSize: '0.72rem'
                          }}
                        >
                          ⏯ Jump Mid
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const audio = audioRef.current
                            if (audio) {
                              const end = dur * 0.9
                              audio.currentTime = end
                              setMainCurrentTime(end)
                            }
                          }}
                          style={{
                            flex: 1,
                            background: 'rgba(255,255,255,0.08)',
                            color: '#fff',
                            border: '1px solid rgba(255,255,255,0.15)',
                            borderRadius: '6px',
                            padding: '4px 8px',
                            cursor: 'pointer',
                            fontSize: '0.72rem'
                          }}
                        >
                          ⏭ Jump End
                        </button>
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
                <button type="button" className="ctrl-btn speed-btn" style={{ background: 'rgba(255,255,255,0.1)', color: '#fff', borderColor: 'rgba(255,255,255,0.1)', padding: '5px 10px' }} onClick={() => applySpeedDelta(-1)}>−1%</button>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative' }}>
                  <input
                    type="range"
                    className="speed-slider"
                    style={{ width: '100%', margin: 0 }}
                    min={-30}
                    max={30}
                    step={1}
                    value={settings.speedPct}
                    onChange={(e) => setSettings((prev) => ({ ...prev, speedPct: Number(e.target.value) }))}
                  />
                  {/* Custom Ticks */}
                  <div style={{ position: 'relative', height: '6px', marginTop: '2px', width: '100%' }}>
                    {[-30, -25, -20, -15, -10, -5, 0, 5, 10, 15, 20, 25, 30].map((val) => {
                      const leftPct = ((val + 30) / 60) * 100
                      const isMajor = val % 10 === 0
                      return (
                        <div
                          key={val}
                          style={{
                            position: 'absolute',
                            left: `${leftPct}%`,
                            transform: 'translateX(-50%)',
                            width: '1px',
                            height: isMajor ? '6px' : '4px',
                            background: val === 0 ? '#4cd8b0' : 'rgba(255, 255, 255, 0.4)',
                            top: 0
                          }}
                        />
                      )
                    })}
                  </div>
                  {/* Labels */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2px', fontSize: '0.62rem', color: '#a0b2bd', padding: '0 2px' }}>
                    <span>-30%</span>
                    <span>-20%</span>
                    <span>-10%</span>
                    <span style={{ color: '#4cd8b0', fontWeight: 'bold' }}>0%</span>
                    <span>+10%</span>
                    <span>+20%</span>
                    <span>+30%</span>
                  </div>
                </div>
                <button type="button" className="ctrl-btn speed-btn" style={{ background: 'rgba(255,255,255,0.1)', color: '#fff', borderColor: 'rgba(255,255,255,0.1)', padding: '5px 10px' }} onClick={() => applySpeedDelta(1)}>+1%</button>
                <span className="speed-label" style={{ color: '#fff9ef', fontSize: '0.85rem', minWidth: '45px', textAlign: 'right' }}>{settings.speedPct > 0 ? '+' : ''}{settings.speedPct}%</span>
              </div>

              {/* Integrated Zoom Waveform Canvas */}
              {currentTrack && (
                <div className="zoom-section" style={{ background: '#071620', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '12px', padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div ref={zoomBeatPillRef} className="zoom-beat-pill" style={{ margin: 0, fontSize: '0.8rem', padding: '2px 8px', borderRadius: '4px' }}>
                      Beat -
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#a0b2bd' }}>
                      Range: <strong>{zoomBarsCount} Bars</strong>
                    </div>
                  </div>

                  <div className="zoom-canvas-container" style={{ position: 'relative', width: '100%', height: '70px', background: '#0b1f2a', borderRadius: '8px', overflow: 'hidden' }}>
                    <canvas ref={zoomCanvasRef} className="zoom-canvas" style={{ width: '100%', height: '100%', display: 'block' }} />
                  </div>

                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button
                        type="button"
                        onClick={handleTapBeat1}
                        style={{
                          background: 'linear-gradient(180deg, #ff8a65 0%, #ff7043 100%)',
                          color: '#fff',
                          border: '1px solid #e64a19',
                          borderRadius: '6px',
                          padding: '4px 10px',
                          fontWeight: 'bold',
                          cursor: 'pointer',
                          fontSize: '0.75rem'
                        }}
                      >
                        {(!currentTrack.beatPairs || currentTrack.beatPairs.length === 0) ? (
                          `🥁 Tap Beat 1 (${tapTimes.length}/2)`
                        ) : (
                          '🎯 Align Late Beat 1'
                        )}
                      </button>
                      
                      {((currentTrack.beatPairs && currentTrack.beatPairs.length > 0) || currentTrack.lateBeatSec !== undefined) && (
                        <button
                          type="button"
                          onClick={handleResetBeats}
                          style={{
                            background: 'rgba(255,255,255,0.1)',
                            color: '#fff',
                            border: '1px solid rgba(255,255,255,0.2)',
                            borderRadius: '6px',
                            padding: '4px 10px',
                            cursor: 'pointer',
                            fontSize: '0.75rem'
                          }}
                        >
                          ✕ Reset
                        </button>
                      )}
                    </div>

                    {/* Fine tune control */}
                    {currentTrack.beatPairs && currentTrack.beatPairs.length > 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <span style={{ fontSize: '0.72rem', color: '#a0b2bd', textTransform: 'uppercase', letterSpacing: '0.05em', marginRight: '4px' }}>Fine-Tune:</span>
                        <button
                          type="button"
                          onClick={() => fineTuneInterval(-1)}
                          style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.15)', color: '#fff', borderRadius: '4px', padding: '2px 6px', fontSize: '0.72rem', cursor: 'pointer', fontWeight: 'bold' }}
                          title="Subtract 1ms from interval"
                        >
                          ◀ -1ms
                        </button>
                        <span style={{ fontSize: '0.75rem', fontWeight: 'bold', minWidth: '40px', textAlign: 'center', color: '#ffd56b' }}>
                          {currentTrack.intervalOffsetSec ? `${(currentTrack.intervalOffsetSec * 1000).toFixed(0)}ms` : '0ms'}
                        </span>
                        <button
                          type="button"
                          onClick={() => fineTuneInterval(1)}
                          style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.15)', color: '#fff', borderRadius: '4px', padding: '2px 6px', fontSize: '0.72rem', cursor: 'pointer', fontWeight: 'bold' }}
                          title="Add 1ms to interval"
                        >
                          +1ms ▶
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
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
                {/* Playback Sequence */}
                <div>
                  <h4 style={{ margin: '0 0 6px', fontSize: '0.9rem', borderBottom: '1px solid rgba(255, 255, 255, 0.15)', paddingBottom: '4px' }}>Playback sequence</h4>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {(['default', 'rating', 'shuffle'] as const).map((mode) => {
                      const labels = {
                        default: 'Default (Playlist)',
                        rating: 'Best to Worst',
                        shuffle: 'Shuffle'
                      }
                      return (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => setSettings((prev) => ({ ...prev, playSequence: mode }))}
                          style={{
                            flex: 1,
                            padding: '6px 8px',
                            fontSize: '0.8rem',
                            background: (settings.playSequence ?? 'default') === mode ? '#00b06b' : 'rgba(255,255,255,0.1)',
                            color: '#fff',
                            border: '1px solid rgba(255,255,255,0.15)',
                            borderRadius: '8px',
                            cursor: 'pointer',
                            fontWeight: (settings.playSequence ?? 'default') === mode ? 'bold' : 'normal'
                          }}
                        >
                          {(settings.playSequence ?? 'default') === mode ? '✓ ' : ''}{labels[mode]}
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="row compact" style={{ margin: 0, display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                  <label className="check" style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '10px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={settings.wdsfTimedMode}
                      onChange={(e) => setSettings((prev) => ({ ...prev, wdsfTimedMode: e.target.checked }))}
                    />
                    <span>⏱️ WDSF timed mode</span>
                  </label>
                  <label className="check" style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '10px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={sessionRule.announcementEnabled}
                      onChange={(e) => setSessionRule((prev) => ({ ...prev, announcementEnabled: e.target.checked }))}
                    />
                    <span>📢 Announce next dance</span>
                  </label>
                  <label className="check" style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '10px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={settings.repeatPlaylist ?? false}
                      onChange={(e) => setSettings((prev) => ({ ...prev, repeatPlaylist: e.target.checked }))}
                    />
                    <span>🔁 Repeat playlist</span>
                  </label>
                </div>

                {/* Beat tapping latency */}
                <div>
                  <h4 style={{ margin: '0 0 6px', fontSize: '0.9rem', borderBottom: '1px solid rgba(255, 255, 255, 0.15)', paddingBottom: '4px' }}>Beat tapping latency</h4>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <input
                      type="range"
                      min={0}
                      max={400}
                      step={10}
                      value={settings.tapLatencyMs ?? 100}
                      onChange={(e) => setSettings((prev) => ({ ...prev, tapLatencyMs: Number(e.target.value) }))}
                      style={{ flex: 1, accentColor: '#ff7043', cursor: 'ew-resize' }}
                    />
                    <span style={{ fontSize: '0.85rem', minWidth: '60px', textAlign: 'right' }}>{settings.tapLatencyMs ?? 100} ms</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
                    <p style={{ margin: 0, fontSize: '0.75rem', color: '#a0b2bd' }}>
                      Compensates for human reaction delay and audio system latency.
                    </p>
                    <button
                      type="button"
                      onClick={startCalibration}
                      style={{
                        background: 'rgba(255, 112, 67, 0.15)',
                        border: '1px solid #ff7043',
                        color: '#ff7043',
                        borderRadius: '4px',
                        padding: '3px 8px',
                        fontSize: '0.75rem',
                        cursor: 'pointer',
                        fontWeight: 'bold',
                        transition: 'background 0.2s'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255, 112, 67, 0.25)'}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(255, 112, 67, 0.15)'}
                    >
                      ⚡ Calibrate
                    </button>
                  </div>
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

              </div>
            </details>

            {/* ── Upcoming queue ── */}
            {playableEntries.length > 0 && (
              <>
                <h3 className="upcoming-heading">
                  Up next
                  {currentIndex >= 0 && (
                    <span className="upcoming-progress">
                      {currentIndex + 1} / {playableEntries.length}
                    </span>
                  )}
                </h3>
                <div className="player-queue-list">
                  {playableEntries.map((entry, index) => {
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
                          <span className="pq-title" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                            {cleanDisplayTitle(t.title)}
                            {t.beatPairs && t.beatPairs.length > 0 && (
                              <span title="Beat alignment grid added" style={{ fontSize: '0.85rem', color: '#ff7043', cursor: 'default' }}>🥁</span>
                            )}
                          </span>
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
                onClick={() => setShowResetConfirm(true)}
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

            <section className="panel panel-backup" style={{ marginTop: '20px', marginBottom: '20px' }}>
              <h2>Dynamic Counting Phrase Mapping</h2>
              <p className="hint">
                When playing a song with alignment grid metadata, the player displays a dynamic counting bar helper (Zählweise der Tänzer) formatted for each specific dance:
              </p>
              <div style={{
                marginTop: '15px',
                padding: '15px',
                background: 'rgba(255, 255, 255, 0.05)',
                borderRadius: '8px',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                fontSize: '13px',
                lineHeight: '1.6'
              }}>
                <ul style={{ paddingLeft: '20px', margin: 0, display: 'flex', flexDirection: 'column', gap: '10px', listStyleType: 'disc' }}>
                  <li>
                    <strong>Waltz &amp; Viennese Waltz:</strong> Displays <code>1 - 2 - 3</code>.
                  </li>
                  <li>
                    <strong>Tango:</strong> Displays <code>1 - 2 - 3 - 4</code>.
                  </li>
                  <li>
                    <strong>Foxtrot &amp; Quickstep:</strong> Displays <code>1 - 2 - 3 - 4</code>.
                  </li>
                  <li>
                    <strong>Samba:</strong> Displays <code>1 - a - 2</code>. Timings &amp; Durations: <strong>1</strong> starts on Beat 1.0 (Duration: 0.75 beat / Dotted 8th note), <strong>a</strong> starts on Beat 1.75 (Duration: 0.25 beat / 16th note), <strong>2</strong> starts on Beat 2.0 (Duration: 1 full beat).
                  </li>
                  <li>
                    <strong>ChaCha:</strong> Displays <code>2 - 3 - 4 &amp; 1</code>, highlighting each beat and subdivision (splitting beat 4 into 4 and &amp; on the eighth note).
                  </li>
                  <li>
                    <strong>Rumba:</strong> Displays <code>2 - 3 - 4 - 1</code>.
                  </li>
                  <li>
                    <strong>Paso Doble:</strong> Displays the full 8-count phrase <code>1 - 2 - 3 - 4 - 5 - 6 - 7 - 8</code> across a 4-bar progression.
                  </li>
                  <li>
                    <strong>Jive:</strong> Displays <code>1 - 2 - 3 - 4</code>.
                  </li>
                  <li>
                    <strong>Other:</strong> Dynamically outputs the standard beat numbers (e.g. <code>1 - 2 - 3 - 4</code>).
                  </li>
                </ul>
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
                                    <span className="dance-track-title" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                                      {cleanDisplayTitle(t.title)}
                                      {t.beatPairs && t.beatPairs.length > 0 && (
                                        <span title="Beat alignment grid added" style={{ fontSize: '0.85rem', color: '#ff7043', cursor: 'default' }}>🥁</span>
                                      )}
                                    </span>
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
          { id: 'songs', label: 'Songs', icon: '♫', badge: null },
          { id: 'playlists', label: 'Playlists', icon: '☰', badge: playlist.entries.filter((e) => e.type === 'track').length || null },
          { id: 'player', label: 'Player', icon: '▶', badge: activeEntryId ? playlist.entries.filter((e) => e.type === 'track').length || null : null },
          { id: 'export', label: 'Export', icon: '⬆', badge: null },
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

      {showResetConfirm && (
        <div className="edit-modal-overlay" style={{ zIndex: 1100 }} onClick={() => setShowResetConfirm(false)}>
          <div className="edit-modal" style={{ maxWidth: '400px' }} onClick={(e) => e.stopPropagation()}>
            <h3 className="edit-modal-title" style={{ color: '#b71c1c' }}>Confirm Reset</h3>
            <p style={{ margin: '15px 0', color: 'var(--text-light)', lineHeight: '1.5' }}>
              Are you sure you want to delete ALL songs, playlists, and cached audio? This action is permanent and cannot be undone.
            </p>
            <div className="edit-modal-row" style={{ marginTop: '20px', gap: '10px', display: 'flex' }}>
              <button
                type="button"
                className="btn-danger"
                style={{ flex: 1, padding: '10px' }}
                onClick={() => {
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
                  setShowResetConfirm(false)
                  setStatus('App reset to default.')
                }}
              >
                Yes, Reset Everything
              </button>
              <button
                type="button"
                className="edit-modal-close"
                style={{ flex: 1, margin: 0, padding: '10px' }}
                onClick={() => setShowResetConfirm(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}



      {isCalibratingLatency && (
        <div className="edit-modal-overlay" style={{ zIndex: 1200 }} onClick={cancelCalibration}>
          <div className="edit-modal" style={{ background: '#0b1f2a', color: '#fff9ef', border: '1px solid rgba(255,255,255,0.1)', textAlign: 'center', padding: '24px' }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 12px', fontSize: '1.2rem', color: '#ffd56b' }}>⚡ Latency Calibration</h3>
            
            <p style={{ fontSize: '0.9rem', color: '#a0b2bd', lineHeight: '1.4', margin: '0 0 20px' }}>
              We will play rhythmic clicks. Tap the big button below (or press your <strong>Spacebar</strong>) exactly on each click sound until you have completed 10 taps.
            </p>

            <div style={{ margin: '20px 0', fontSize: '1.1rem', fontWeight: 'bold' }}>
              {calibrationResult === null ? (
                <span>Taps: {calibrationTaps.length} / 10</span>
              ) : (
                <span style={{ color: '#4cd8b0' }}>Test Complete!</span>
              )}
            </div>

            {calibrationResult === null ? (
              <button
                type="button"
                onClick={handleCalibrationTap}
                style={{
                  width: '120px',
                  height: '120px',
                  borderRadius: '50%',
                  background: calibrationFlash ? '#ffd56b' : '#ff7043',
                  border: 'none',
                  color: '#fff',
                  fontSize: '1.2rem',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  outline: 'none',
                  boxShadow: '0 4px 15px rgba(0,0,0,0.3)',
                  transition: 'background 0.05s, transform 0.05s',
                  transform: calibrationFlash ? 'scale(0.95)' : 'scale(1)',
                  margin: '10px auto'
                }}
              >
                TAP!
              </button>
            ) : (
              <div style={{ padding: '12px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px', margin: '16px 0' }}>
                {calibrationResult > 0 ? (
                  <div>
                    <div style={{ fontSize: '0.85rem', color: '#a0b2bd' }}>Estimated Latency:</div>
                    <div style={{ fontSize: '1.8rem', fontWeight: 'bold', color: '#ffd56b', margin: '4px 0' }}>
                      {calibrationResult} ms
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#a0b2bd' }}>
                      ({calibrationTaps.length} taps recorded)
                    </div>
                  </div>
                ) : (
                  <div style={{ color: '#ff7043', fontSize: '0.9rem' }}>
                    No valid taps detected. Make sure to tap exactly when you hear the clicks.
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', gap: '10px', marginTop: '24px' }}>
              {calibrationResult !== null && calibrationResult > 0 && (
                <button
                  type="button"
                  style={{
                    flex: 1,
                    background: '#4cd8b0',
                    color: '#0b1f2a',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '10px',
                    fontWeight: 'bold',
                    cursor: 'pointer'
                  }}
                  onClick={() => {
                    setSettings(prev => ({ ...prev, tapLatencyMs: calibrationResult }))
                    cancelCalibration()
                  }}
                >
                  Apply {calibrationResult} ms
                </button>
              )}
              <button
                type="button"
                className="edit-modal-close"
                style={{ flex: 1, margin: 0, padding: '10px', background: 'rgba(255,255,255,0.1)', color: '#fff' }}
                onClick={cancelCalibration}
              >
                {calibrationResult === null ? 'Cancel' : 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App

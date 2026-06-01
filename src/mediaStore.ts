const DB_NAME = 'danceplayer-media'
const DB_VERSION = 1
const STORE_NAME = 'tracks'

interface StoredAudio {
  trackId: string
  name: string
  type: string
  blob: Blob
  updatedAt: number
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'trackId' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  const db = await openDb()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode)
    const store = tx.objectStore(STORE_NAME)

    fn(store)
      .then((result) => {
        tx.oncomplete = () => {
          db.close()
          resolve(result)
        }
      })
      .catch((error) => {
        tx.abort()
        db.close()
        reject(error)
      })

    tx.onerror = () => {
      db.close()
      reject(tx.error)
    }
  })
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function saveAudioFile(trackId: string, file: File): Promise<void> {
  await withStore('readwrite', async (store) => {
    const payload: StoredAudio = {
      trackId,
      name: file.name,
      type: file.type || 'audio/mpeg',
      blob: file,
      updatedAt: Date.now(),
    }
    await requestToPromise(store.put(payload))
  })
}

export async function getAudioFile(trackId: string): Promise<File | null> {
  return withStore('readonly', async (store) => {
    const record = await requestToPromise(store.get(trackId) as IDBRequest<StoredAudio | undefined>)
    if (!record) return null
    return new File([record.blob], record.name, { type: record.type })
  })
}

export async function removeAudioFile(trackId: string): Promise<void> {
  await withStore('readwrite', async (store) => {
    await requestToPromise(store.delete(trackId))
  })
}

export async function clearAllAudioFiles(): Promise<void> {
  await withStore('readwrite', async (store) => {
    await requestToPromise(store.clear())
  })
}

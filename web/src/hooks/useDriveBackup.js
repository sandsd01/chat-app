import { useCallback, useEffect, useState } from 'react'
import { getDriveStatus, startDriveConnect, disconnectDrive, syncDriveNow } from '../api/drive'

// 'loading' | 'connected' | 'disconnected'
export function useDriveBackup(token) {
  const [status, setStatus] = useState('loading')
  const [connectedAt, setConnectedAt] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [lastSync, setLastSync] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const data = await getDriveStatus(token)
      setStatus(data.connected ? 'connected' : 'disconnected')
      setConnectedAt(data.connectedAt)
    } catch (err) {
      setError(err.message)
    }
  }, [token])

  useEffect(() => {
    refresh()
  }, [refresh])

  const connect = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      const { url } = await startDriveConnect(token)
      // Full-page redirect to Google — this tab doesn't come back to a
      // resolved promise, it navigates away entirely.
      window.location.href = url
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }, [token])

  const disconnect = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      await disconnectDrive(token)
      setStatus('disconnected')
      setConnectedAt(null)
      setLastSync(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }, [token])

  const sync = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      const result = await syncDriveNow(token)
      setLastSync(result)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }, [token])

  return { status, connectedAt, error, busy, lastSync, connect, disconnect, sync, refresh }
}

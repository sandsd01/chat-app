import { useCallback, useEffect, useState } from 'react'
import { getVapidPublicKey, subscribePush, unsubscribePush, urlBase64ToUint8Array } from '../api/push'

// 'unsupported' | 'denied' | 'subscribed' | 'unsubscribed'
export function usePushSubscription(token) {
  const [status, setStatus] = useState('unsubscribed')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window

  useEffect(() => {
    if (!supported) {
      setStatus('unsupported')
      return
    }
    if (Notification.permission === 'denied') {
      setStatus('denied')
      return
    }
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setStatus(sub ? 'subscribed' : 'unsubscribed'))
      .catch(() => setStatus('unsubscribed'))
  }, [supported])

  const subscribe = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setStatus('denied')
        return
      }
      const { publicKey } = await getVapidPublicKey(token)
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      })
      await subscribePush(subscription.toJSON(), token)
      setStatus('subscribed')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }, [token])

  const unsubscribe = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()
      if (subscription) {
        await unsubscribePush(subscription.endpoint, token)
        await subscription.unsubscribe()
      }
      setStatus('unsubscribed')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }, [token])

  return { status, error, busy, subscribe, unsubscribe }
}

import { apiFetch } from './client'

export function getVapidPublicKey(token) {
  return apiFetch('/push/vapid-public-key', { token })
}

export function subscribePush(subscription, token) {
  return apiFetch('/push/subscribe', { method: 'POST', body: { subscription }, token })
}

export function unsubscribePush(endpoint, token) {
  return apiFetch('/push/unsubscribe', { method: 'POST', body: { endpoint }, token })
}

// PushManager.subscribe wants the VAPID public key as a Uint8Array
// (the raw applicationServerKey bytes), not the base64url string the
// server hands back — this is the standard conversion for that.
export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

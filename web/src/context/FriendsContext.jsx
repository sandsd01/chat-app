import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from './AuthContext'
import { useChat } from './ChatContext'
import {
  listFriends,
  listRequests,
  sendFriendRequest,
  acceptFriendRequest,
  declineFriendRequest,
  cancelFriendRequest,
  removeFriend as removeFriendApi,
  blockUser as blockUserApi,
  unblockUser as unblockUserApi,
} from '../api/friends'

const FriendsContext = createContext(null)

// Every action below is the same shape — call the API, then refetch so
// friends/incoming/outgoing reflect the mutation — differing only in which
// API function and argument they use.
function useMutateAndRefresh(apiFn, token, refresh) {
  return useCallback(
    async (arg) => {
      const result = await apiFn(arg, token)
      await refresh()
      return result
    },
    [apiFn, token, refresh]
  )
}

export function FriendsProvider({ children }) {
  const { token } = useAuth()
  const { subscribeToFriendEvents } = useChat()

  const [friends, setFriends] = useState([])
  const [incoming, setIncoming] = useState([])
  const [outgoing, setOutgoing] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // refresh() is called from several places that can overlap (mount, the
  // live "friend" event, and every action handler below) — without
  // ordering, a slower/older request resolving after a newer one would
  // overwrite fresh state with stale data. seqRef tags each call and only
  // applies a response if no newer call has started since.
  const seqRef = useRef(0)

  // Rethrows after recording `error`, so an action handler's `await refresh()`
  // (see sendRequest/acceptRequest/etc. below) fails loudly when the mutation
  // itself succeeded but the follow-up refetch didn't — otherwise the action
  // looked like a silent no-op: the button stops being busy, no error shows,
  // and the request row never disappears, even though it worked server-side.
  // The two call sites below that don't want that (mount, and the live
  // "friend" event) catch it themselves.
  const refresh = useCallback(async () => {
    if (!token) return
    const mySeq = ++seqRef.current
    setLoading(true)
    setError(null)
    try {
      const [friendsList, requests] = await Promise.all([listFriends(token), listRequests(token)])
      if (mySeq !== seqRef.current) return
      setFriends(friendsList)
      setIncoming(requests.incoming)
      setOutgoing(requests.outgoing)
    } catch (err) {
      if (mySeq === seqRef.current) setError(err.message)
      throw err
    } finally {
      if (mySeq === seqRef.current) setLoading(false)
    }
  }, [token])

  useEffect(() => {
    if (!token) {
      setFriends([])
      setIncoming([])
      setOutgoing([])
      return
    }
    refresh().catch(() => {})
  }, [token, refresh])

  // Live updates: a "friend" event over the shared SSE stream (see
  // ChatContext#subscribeToFriendEvents) means a request arrived or got
  // accepted somewhere else — just refetch rather than trying to patch
  // state from the event's bare `{ type }` payload, since a full refresh is
  // cheap and keeps this in sync with the same source of truth the mount
  // effect above already trusts.
  useEffect(() => {
    if (!token) return
    return subscribeToFriendEvents(() => {
      refresh().catch(() => {})
    })
  }, [token, subscribeToFriendEvents, refresh])

  const sendRequest = useMutateAndRefresh(sendFriendRequest, token, refresh)
  const acceptRequest = useMutateAndRefresh(acceptFriendRequest, token, refresh)
  const declineRequest = useMutateAndRefresh(declineFriendRequest, token, refresh)
  const cancelRequest = useMutateAndRefresh(cancelFriendRequest, token, refresh)
  const removeFriend = useMutateAndRefresh(removeFriendApi, token, refresh)
  const blockUser = useMutateAndRefresh(blockUserApi, token, refresh)
  const unblockUser = useMutateAndRefresh(unblockUserApi, token, refresh)

  const value = useMemo(
    () => ({
      friends,
      incoming,
      outgoing,
      loading,
      error,
      incomingCount: incoming.length,
      refresh,
      sendRequest,
      acceptRequest,
      declineRequest,
      cancelRequest,
      removeFriend,
      blockUser,
      unblockUser,
    }),
    [
      friends,
      incoming,
      outgoing,
      loading,
      error,
      refresh,
      sendRequest,
      acceptRequest,
      declineRequest,
      cancelRequest,
      removeFriend,
      blockUser,
      unblockUser,
    ]
  )

  return <FriendsContext.Provider value={value}>{children}</FriendsContext.Provider>
}

export function useFriends() {
  const ctx = useContext(FriendsContext)
  if (!ctx) throw new Error('useFriends must be used within a FriendsProvider')
  return ctx
}

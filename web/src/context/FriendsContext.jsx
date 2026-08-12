import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useAuth } from './AuthContext'
import { useStream } from './StreamContext'
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

// Friend requests and acceptances arrive live over the shared SSE stream as
// `friend` events (see StreamContext), on top of the refetch-on-mount and
// refetch-after-every-action this already did. Decline, cancel, unfriend and
// block publish nothing and stay stale-until-refetch — they're out of scope
// deliberately, not missed.
export function FriendsProvider({ children }) {
  const { token } = useAuth()
  const { subscribe } = useStream()

  const [friends, setFriends] = useState([])
  const [incoming, setIncoming] = useState([])
  const [outgoing, setOutgoing] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      const [friendsList, requests] = await Promise.all([listFriends(token), listRequests(token)])
      setFriends(friendsList)
      setIncoming(requests.incoming)
      setOutgoing(requests.outgoing)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    if (!token) {
      setFriends([])
      setIncoming([])
      setOutgoing([])
      return
    }
    refresh()
  }, [token, refresh])

  // Just refetch rather than patching state from the payload: it's two cheap
  // queries, it's the exact function every button handler already calls, and
  // it can't drift from server state the way hand-patched local state can.
  useEffect(() => subscribe('friend', () => refresh()), [subscribe, refresh])

  const sendRequest = useCallback(
    async (publicId) => {
      const result = await sendFriendRequest(publicId, token)
      await refresh()
      return result
    },
    [token, refresh]
  )

  const acceptRequest = useCallback(
    async (requestId) => {
      await acceptFriendRequest(requestId, token)
      await refresh()
    },
    [token, refresh]
  )

  const declineRequest = useCallback(
    async (requestId) => {
      await declineFriendRequest(requestId, token)
      await refresh()
    },
    [token, refresh]
  )

  const cancelRequest = useCallback(
    async (requestId) => {
      await cancelFriendRequest(requestId, token)
      await refresh()
    },
    [token, refresh]
  )

  const removeFriend = useCallback(
    async (userId) => {
      await removeFriendApi(userId, token)
      await refresh()
    },
    [token, refresh]
  )

  const blockUser = useCallback(
    async (userId) => {
      await blockUserApi(userId, token)
      await refresh()
    },
    [token, refresh]
  )

  const unblockUser = useCallback(
    async (userId) => {
      await unblockUserApi(userId, token)
      await refresh()
    },
    [token, refresh]
  )

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

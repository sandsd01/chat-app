# Live friend-request updates

Date: 2026-08-13
Status: approved, not yet implemented
Roadmap item: CLAUDE.md Roadmap #1

## Problem

`web/src/context/FriendsContext.jsx` refetches only on mount and after an action
taken through it. A friend request that arrives — or an acceptance that lands —
while the tab is open and idle doesn't appear until something else triggers a
refetch. Web Push already covers the case where the app *isn't* open
(`src/routes/friends.js#notify`), so the gap is specifically the open-and-idle
tab: the OS notification fires, the user switches to the already-open tab, and
the request isn't there.

Chat solved this with SSE. Friends should reuse that connection rather than
grow a parallel one.

## Scope

In scope — the two mutations that already call `notify()`:

- a friend request is created (`POST /friends/requests`, the `!existing` branch)
- a request is accepted, by either route to acceptance:
  - `POST /friends/requests/:id/accept`
  - `POST /friends/requests` hitting the mutual-request auto-accept branch

Out of scope, deliberately: decline, cancel, unfriend, block. None of these
call `notify()` today, so they'd be new notification plumbing rather than reuse
of an existing decision. They stay as stale-until-refetch, exactly as today —
this change doesn't make them worse.

Also out of scope: any toast/snackbar UI. The frontend has no toast component,
and adding one is a separate design question. Live updates surface as the
existing lists and badge count changing in place.

## Architecture

Three parts. The backend change is small; the bulk is a frontend extraction
that is mostly moving existing code.

### 1. Backend — publish friend events onto the existing per-user bus

`src/lib/chatBus.js` is already generic: it keys channels by `user:<id>` and
`publish(userId, event, payload)` takes an arbitrary event name. Despite the
name it is not chat-specific. **No changes to this file.**

`src/routes/chat.js`'s `GET /stream` handler forwards whatever it receives
verbatim:

```js
res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
```

so a new event name flows to the client with **no changes to the stream route,
no new ticket route, and no new SSE endpoint.**

The only backend change is in `src/routes/friends.js`: `notify()` gains a
`chatBus.publish` alongside the existing `sendPushToUser`.

```js
const chatBus = require("../lib/chatBus");

async function notify(userId, title, body, payload) {
  chatBus.publish(userId, "friend", payload);
  sendPushToUser(userId, { title, body }).catch((err) =>
    console.error("Push notification failed:", err)
  );
}
```

The new fourth parameter is the *payload*, not the event name — `chatBus`'s
own second argument is the event name, and that is always the literal
`"friend"` here. Don't name the parameter `event`; it reads as the wrong slot.

Payload shape: `{ type: "request" }` or `{ type: "accepted" }`. The client
treats both identically today (both trigger the same refetch), but naming the
type keeps the door open for differentiated handling without a payload
migration.

Note the asymmetry with chat, and keep it: chat gates its push on
`chatBus.hasSubscribers(otherUserId)` because a live SSE stream will deliver
the same message a moment later. Friends must **not** adopt that gate. A user
with a chat stream open has a *connection*, which is not the same as having
*seen* a friend request — they may be on a different route entirely, or the
tab may be backgrounded. Keep the push unconditional, exactly as the comment in
`friends.js` already argues.

No schema changes. No new environment variables.

### 2. Frontend — extract `StreamContext`

New file `web/src/context/StreamContext.jsx`. It takes over, unchanged in
behaviour, what `ChatContext` owns today:

- the `getStreamTicket` fetch
- `EventSource` construction and teardown
- reconnect backoff (`RECONNECT_BASE_MS` 1s → `RECONNECT_MAX_MS` 30s,
  `DOWN_AFTER_ATTEMPTS` 4), including the `connectRef` indirection that
  sidesteps the `connect`/`scheduleReconnect` circular dependency
- the `connectionState` state machine (`reconnecting` / `connected` / `down`)
- the connect-on-token-change / teardown-on-logout effect

Public API:

```js
useStream() // -> { connectionState, subscribe(eventName, callback) }
```

`subscribe` returns an unsubscribe function, mirroring the existing
`subscribeToConversation` convention already in `ChatContext`.

**Reconnect-safe subscription.** `EventSource` has no wildcard listener, and
the instance is thrown away and rebuilt on every reconnect. So subscribers
cannot be registered directly against an `EventSource`. Instead:

- `listenersRef: Map<eventName, Set<callback>>` lives in a ref, surviving
  reconnects untouched.
- A module-level `const STREAM_EVENTS = ['message', 'friend']` lists every
  named event the server sends. On each new `EventSource`, attach one
  dispatcher per entry; each dispatcher JSON-parses and fans out to
  `listenersRef.get(name)`.
- Malformed payloads are swallowed per-event, matching the existing
  `try { ... } catch { /* ignore malformed payloads */ }` in `ChatContext`.

Adding a future event type is a one-line change to `STREAM_EVENTS`. A
subscriber registering for a name not in that list would silently never fire —
acceptable for a two-entry list in one small file, and the alternative
(attaching lazily on first subscribe, tracking attached names per instance) is
more machinery than this earns.

Provider nesting in `web/src/App.jsx` becomes:

```
LanguageProvider > AuthProvider > StreamProvider > ChatProvider > FriendsProvider
```

`StreamProvider` needs `useAuth()` for the token, and both consumers need the
stream, so it sits directly under `AuthProvider`. Chat and Friends keep their
current relative order; neither depends on the other.

### 3. Frontend — wire up the two consumers

**`ChatContext`** loses its `EventSource`/ticket/backoff code entirely (~60
lines move to `StreamContext`) and instead:

- calls `useStream()`
- subscribes to `'message'` in an effect, routing to the existing
  `handleIncomingMessage` unchanged
- re-exports `connectionState` from the stream context in its own context value

That last point matters: `web/src/pages/ChatPage.jsx` reads
`useChat().connectionState` for its reconnecting/disconnected banner.
Re-exporting keeps that working with **zero changes to `ChatPage.jsx`**. The
banner is now technically reporting shared-connection health rather than
chat-specific health, which is accurate — it's the same connection, and the
banner's user-facing meaning ("live updates aren't flowing") is unchanged.

`handleIncomingMessage`, `subscribeToConversation`, `markConversationRead`,
`startChat`, and `unreadTotal` are untouched.

**`FriendsContext`** calls `useStream()` and subscribes to `'friend'`, with the
handler calling its existing `refresh()`. No incremental state patching: a
refetch of friends + requests is two cheap queries, it's the exact function
every button handler already calls, and it cannot drift from server state the
way hand-patched local state can. The stale comment at the top of the file
(lines 17–21, describing the absence of this feature) gets replaced with a
short note on what it now does.

## Data flow

```
Alice: POST /api/friends/requests { publicId: BOB }
  → friends.js creates the Friendship row
  → notify(bob.id, ...) →  sendPushToUser(bob.id)        [unchanged]
                        └→ chatBus.publish(bob.id, "friend", { type: "request" })
  → chatBus emits on channel "user:<bob.id>"
  → chat.js GET /stream handler (Bob's open connection) writes:
       event: friend
       data: {"type":"request"}
  → Bob's StreamContext 'friend' dispatcher fans out to listeners
  → FriendsContext handler calls refresh()
  → GET /friends + GET /friends/requests
  → incoming list and badge count re-render
```

If Bob has no stream open, `chatBus.publish` reaches zero listeners and is a
no-op — the push notification is what reaches him, unchanged from today.

## Error handling

- **Bob offline / no stream open** — `publish` no-ops. Push covers it. On next
  page load `FriendsContext` refetches on mount as it always has.
- **Stream drops mid-session** — existing backoff reconnects; on reconnect
  `FriendsContext`'s subscription is still live in `listenersRef` and needs no
  re-registration. Events published *during* the disconnect are lost (SSE here
  has no replay/`Last-Event-ID`, same as chat today) — the mount-time refetch
  and any user action still reconcile. Accepted limitation, matching chat's
  existing behaviour.
- **Malformed payload** — swallowed per-event in the dispatcher.
- **`refresh()` fails** — sets `error` in `FriendsContext` via its existing
  try/catch. No new path.
- **Multiple tabs** — each tab has its own `EventSource`, and `chatBus`
  publishes to every subscriber on the channel, so all of a user's open tabs
  refresh. Already true for chat messages.

Single-instance caveat is inherited unchanged: `chatBus` is an in-process
`EventEmitter`, correct only while the app runs as exactly one instance. This
change adds a second consumer of that constraint but does not alter it. See the
`SINGLE INSTANCE ONLY` block in `render.yaml`.

## Testing

**Backend** (`tests/friends.test.js`). Tests import `src/app.js` directly and
run in the same process as `chatBus`, so the real bus can be subscribed to
directly — no mocking needed, which tests the actual publish rather than a
stand-in:

```js
const received = [];
const unsubscribe = chatBus.subscribe(bob.id, (event, payload) =>
  received.push({ event, payload })
);
// ... Alice POSTs the request ...
unsubscribe();
```

Cases:

1. `POST /friends/requests` publishes `friend` / `{ type: "request" }` to the
   recipient.
2. `POST /friends/requests/:id/accept` publishes `friend` /
   `{ type: "accepted" }` to the original requester.
3. The mutual-request auto-accept branch publishes `{ type: "accepted" }` to
   the other user.
4. Nothing is published to an uninvolved third user (Carol) in any of the
   above.

**Frontend.** There is no frontend test suite in this repo (`web/` has no test
files and no test runner configured), and this change is not the right moment
to introduce one. Verification is manual:

- two browsers signed in as different accounts, both idle on `/friends`
- send a request from A → appears in B's incoming list and badge without a
  refresh
- accept from B → A's outgoing list clears and the friend appears, no refresh
- kill the backend → both tabs show the existing reconnecting/disconnected
  banner; restart → banner clears and live updates resume
- confirm chat messages still arrive live (the extraction's main regression
  risk) and that the banner still behaves on `ChatPage`

**Regression.** `npm test` must stay green — the extraction touches no backend
behaviour, and existing `tests/chat.test.js` stream-ticket coverage should be
unaffected. `cd web && npm run build` must pass.

## Files touched

| File | Change |
|---|---|
| `src/routes/friends.js` | `notify()` also publishes to `chatBus`; pass an event payload at each of the 3 call sites |
| `src/lib/chatBus.js` | none |
| `src/routes/chat.js` | none |
| `prisma/schema.prisma` | none |
| `web/src/context/StreamContext.jsx` | **new** — owns the connection, exposes `useStream()` |
| `web/src/context/ChatContext.jsx` | drop connection code, subscribe to `'message'`, re-export `connectionState` |
| `web/src/context/FriendsContext.jsx` | subscribe to `'friend'` → `refresh()`; replace stale comment |
| `web/src/App.jsx` | insert `StreamProvider` under `AuthProvider` |
| `web/src/pages/ChatPage.jsx` | none |
| `tests/friends.test.js` | 4 new cases |
| `CLAUDE.md` | remove Roadmap #1; document `StreamContext` and the friend event |

## Out of scope

- Toast/snackbar notifications for in-app events
- Live updates for decline / cancel / unfriend / block
- SSE event replay (`Last-Event-ID`) after a dropped connection
- Multi-instance fan-out (Redis pub/sub) — still explicitly unsupported
- Roadmap #2 (reading pruned history from Drive) and #3 (role field)

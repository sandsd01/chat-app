# แผนลงมือทำ: Live friend-request updates

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**เป้าหมาย:** ให้คำขอเป็นเพื่อนและการตอบรับคำขอ ปรากฏในหน้าเว็บทันทีโดยไม่ต้องรีเฟรช โดยใช้สาย SSE เส้นเดียวกับที่แชทใช้อยู่

**สถาปัตยกรรม:** ฝั่งเซิร์ฟเวอร์ `src/routes/friends.js` ยิงเหตุการณ์ชื่อ `friend` เข้า `src/lib/chatBus.js` ตัวเดิม (ช่องทางแยกตาม `user:<id>` อยู่แล้ว ไม่ผูกกับแชท) — route `GET /api/chat/stream` ส่งต่อเหตุการณ์ชื่ออะไรก็ได้อยู่แล้ว จึงไม่ต้องแก้ ฝั่งหน้าเว็บย้ายโค้ดจัดการการเชื่อมต่อ SSE ออกจาก `ChatContext` มาไว้ใน `StreamContext` ตัวใหม่ ให้ `ChatContext` และ `FriendsContext` ต่างสมัครรับเหตุการณ์จากสายเดียวกัน

**Tech Stack:** Node.js + Express 5, Prisma, `node:test` + Supertest, React + Vite, EventSource (SSE)

## Global Constraints

- **โค้ด คอมเมนต์ในโค้ด ชื่อตัวแปร และ commit message ทั้งหมดเป็นภาษาอังกฤษ** — repo นี้เป็นอังกฤษล้วน ห้ามเขียนคอมเมนต์เป็นภาษาไทยลงในซอร์ส (เอกสารแผนนี้เป็นไทยเพื่อให้เจ้าของโปรเจกต์อ่านได้ ไม่ใช่แบบอย่างของโค้ด)
- ห้ามแก้ `src/lib/chatBus.js` และ `src/routes/chat.js` — ทั้งสองไฟล์รองรับสิ่งที่ต้องการอยู่แล้ว
- ห้ามแก้ `prisma/schema.prisma` — ไม่มีการเปลี่ยนฐานข้อมูล และไม่มี migration ใหม่
- ห้ามแก้ `web/src/pages/ChatPage.jsx` — ต้องทำงานได้เหมือนเดิมโดยไม่ต้องแตะ
- ห้ามเพิ่ม dependency ใหม่ ทั้งฝั่ง root และ `web/`
- ห้ามเพิ่ม environment variable ใหม่
- ชื่อเหตุการณ์บนสายคือ `"friend"` เสมอ ส่วน payload คือ `{ type: "request" }` หรือ `{ type: "accepted" }` เท่านั้น
- อย่าใส่การเช็ค `chatBus.hasSubscribers` ให้ฝั่ง friends — push ต้องยิงทุกครั้ง (เหตุผลอยู่ในคอมเมนต์ที่ Task 1)
- ขอบเขตคือ *ส่งคำขอ* กับ *ตอบรับคำขอ* เท่านั้น — ห้ามเพิ่มเหตุการณ์ให้ decline / cancel / unfriend / block
- ไม่มีชุดทดสอบฝั่งหน้าเว็บใน repo นี้ และแผนนี้ไม่สร้างขึ้นใหม่ — ฝั่งหน้าเว็บตรวจด้วย `npm run lint` + `npm run build` และการทดลองใช้จริงในเบราว์เซอร์

**คำสั่งตรวจสอบที่ใช้ซ้ำตลอดแผน**

```bash
# backend (รัน test:migrate ครั้งเดียวก่อนเริ่ม)
npm run test:migrate
node --test tests/friends.test.js
npm test

# frontend
cd web && npm run lint && npm run build
```

---

### Task 1: ฝั่งเซิร์ฟเวอร์ — ยิงเหตุการณ์ `friend` เข้า chatBus

**Files:**
- Modify: `src/routes/friends.js` (คอมเมนต์+ฟังก์ชัน `notify` บรรทัด 9–17, จุดเรียก 3 จุด บรรทัด 111, 133, 158)
- Test: `tests/friends.test.js`

**Interfaces:**
- Consumes: `chatBus.publish(userId, event, payload)` และ `chatBus.subscribe(userId, fn)` จาก `src/lib/chatBus.js` (มีอยู่แล้ว ไม่แก้)
- Produces: เหตุการณ์ชื่อ `"friend"` บนช่อง `user:<id>` พร้อม payload `{ type: "request" }` หรือ `{ type: "accepted" }` — Task 3 ฝั่งหน้าเว็บพึ่งพาชื่อและรูปแบบนี้

- [ ] **Step 1: เตรียมไฟล์เทส — เพิ่ม import และ helper**

เปิด `tests/friends.test.js` เพิ่ม require ของ chatBus ต่อจาก require เดิม (บรรทัด 1–5):

```js
const chatBus = require("../src/lib/chatBus");
```

แล้วเพิ่ม helper นี้ไว้ใต้ฟังก์ชัน `login` (หลังบรรทัด 10):

```js
// chatBus is an in-process EventEmitter and these tests import src/app.js
// directly, so we can listen on the real bus rather than mocking it — this
// asserts the actual publish, not a stand-in for one.
function captureEvents(userId) {
  const received = [];
  const unsubscribe = chatBus.subscribe(userId, (event, payload) => received.push({ event, payload }));
  return { received, unsubscribe };
}
```

- [ ] **Step 2: เขียนเทสที่ต้องล้มเหลว**

เพิ่ม `describe` block นี้ต่อท้ายไฟล์ `tests/friends.test.js` ก่อนวงเล็บปิดของ `describe("Friends API", ...)` ตัวนอกสุด:

```js
  describe("live friend events on chatBus", () => {
    test("sending a request publishes { type: 'request' } to the recipient only", async () => {
      const bobEvents = captureEvents(bob.id);
      const carolEvents = captureEvents(carol.id);

      const res = await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ publicId: bob.publicId });

      bobEvents.unsubscribe();
      carolEvents.unsubscribe();

      assert.equal(res.status, 201);
      assert.deepEqual(bobEvents.received, [{ event: "friend", payload: { type: "request" } }]);
      assert.deepEqual(carolEvents.received, []);
    });

    test("accepting a request publishes { type: 'accepted' } to the requester only", async () => {
      const sent = await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ publicId: bob.publicId });

      const aliceEvents = captureEvents(alice.id);
      const carolEvents = captureEvents(carol.id);

      const res = await request(app)
        .post(`/api/friends/requests/${sent.body.requestId}/accept`)
        .set("Authorization", `Bearer ${bobToken}`);

      aliceEvents.unsubscribe();
      carolEvents.unsubscribe();

      assert.equal(res.status, 200);
      assert.deepEqual(aliceEvents.received, [{ event: "friend", payload: { type: "accepted" } }]);
      assert.deepEqual(carolEvents.received, []);
    });

    test("the mutual-request auto-accept path publishes { type: 'accepted' }", async () => {
      await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ publicId: bob.publicId });

      const aliceEvents = captureEvents(alice.id);

      // Bob requests Alice back while her request is still pending — this
      // flips the existing row straight to accepted instead of creating a
      // second one, and Alice is the one who needs telling.
      const res = await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${bobToken}`)
        .send({ publicId: alice.publicId });

      aliceEvents.unsubscribe();

      assert.equal(res.status, 200);
      assert.equal(res.body.status, "accepted");
      assert.deepEqual(aliceEvents.received, [{ event: "friend", payload: { type: "accepted" } }]);
    });

    test("declining publishes nothing (out of scope for live updates)", async () => {
      const sent = await request(app)
        .post("/api/friends/requests")
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ publicId: bob.publicId });

      const aliceEvents = captureEvents(alice.id);

      const res = await request(app)
        .post(`/api/friends/requests/${sent.body.requestId}/decline`)
        .set("Authorization", `Bearer ${bobToken}`);

      aliceEvents.unsubscribe();

      assert.equal(res.status, 204);
      assert.deepEqual(aliceEvents.received, []);
    });
  });
```

- [ ] **Step 3: รันเทสให้เห็นว่าล้มเหลว**

```bash
npm run test:migrate
node --test tests/friends.test.js
```

คาดว่า: เทส 3 ตัวแรกล้มเหลว เพราะ `received` เป็น array ว่าง (ยังไม่มีใคร publish) ส่วนตัวที่ 4 (`declining publishes nothing`) จะผ่านตั้งแต่ยังไม่แก้โค้ด — ถูกต้องแล้ว มันเป็นเทสกันพลาด ไม่ให้เผลอเพิ่มเหตุการณ์เกินขอบเขต

- [ ] **Step 4: แก้ `src/routes/friends.js` ให้ publish**

เพิ่ม require ต่อจากบรรทัด 4 (`const { sendPushToUser } = require("../lib/push");`):

```js
const chatBus = require("../lib/chatBus");
```

แล้วแทนที่คอมเมนต์+ฟังก์ชัน `notify` เดิมทั้งก้อน (บรรทัด 9–17) ด้วย:

```js
// Friend events ride the same per-user chatBus channel chat messages use, so
// a client with the shared SSE stream open picks them up live (see
// web/src/context/StreamContext.jsx). Unlike chat's send path this does NOT
// gate the push on chatBus.hasSubscribers: an open stream means the tab is
// connected, not that the person has seen the request — they may be on a
// different route entirely, or the tab may be backgrounded. So both fire.
// `payload` is the chatBus payload, not the event name; the event name is
// always the literal "friend".
async function notify(userId, title, body, payload) {
  chatBus.publish(userId, "friend", payload);
  sendPushToUser(userId, { title, body }).catch((err) => console.error("Push notification failed:", err));
}
```

- [ ] **Step 5: ส่ง payload ที่จุดเรียกทั้ง 3 จุด**

จุดที่ 1 — ใน `POST /requests` สาขา `!existing` (เดิมบรรทัด 111):

```js
    notify(target.id, "New friend request", me.name || me.email, { type: "request" });
```

จุดที่ 2 — ใน `POST /requests` สาขา mutual auto-accept (เดิมบรรทัด 133):

```js
  notify(target.id, "Friend request accepted", `${me.name || me.email} accepted your request`, {
    type: "accepted",
  });
```

จุดที่ 3 — ใน `POST /requests/:id/accept` (เดิมบรรทัด 158):

```js
  notify(row.requestedById, "Friend request accepted", `${me.name || me.email} accepted your request`, {
    type: "accepted",
  });
```

- [ ] **Step 6: รันเทสให้ผ่าน**

```bash
node --test tests/friends.test.js
```

คาดว่า: ผ่านทั้งหมด รวมเทสเดิมของไฟล์นี้ด้วย

- [ ] **Step 7: รันเทสทั้งชุดกันพัง**

```bash
npm test
```

คาดว่า: ผ่านทั้งหมด ไม่มีเทสเดิมพัง (การเพิ่ม publish ไม่กระทบพฤติกรรมของ route ใดๆ)

- [ ] **Step 8: Commit**

```bash
git add src/routes/friends.js tests/friends.test.js
git commit -m "$(cat <<'EOF'
Publish friend request/accept events on the chatBus

notify() now fans the same two moments it already pushes for onto the
per-user chatBus channel, so a client with the SSE stream open can pick
them up live. The push stays unconditional: an open stream means the tab
is connected, not that the request has been seen.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: ฝั่งหน้าเว็บ — แยก `StreamContext` ออกมาถือการเชื่อมต่อ

งานนี้ต้องทำจบในตัวเดียว: ถ้าสร้าง `StreamContext` แล้วไม่ย้าย `ChatContext` มาใช้ จะกลายเป็นเปิดสาย SSE ซ้อนกันสองเส้นต่อหนึ่งแท็บ

**Files:**
- Create: `web/src/context/StreamContext.jsx`
- Modify: `web/src/context/ChatContext.jsx` (ตัดโค้ดการเชื่อมต่อออก บรรทัด 1–12, 20–28, 90–162, 198–221)
- Modify: `web/src/App.jsx` (เพิ่ม import + ครอบ provider)
- Test: ไม่มีชุดทดสอบฝั่งหน้าเว็บ — ตรวจด้วย lint + build + ทดลองใช้จริง

**Interfaces:**
- Consumes: `useAuth()` → `{ token }` จาก `./AuthContext`; `getStreamTicket(token)` จาก `../api/chat` (มีอยู่แล้ว บรรทัด 41–43 ไม่ต้องย้าย เพราะ route จริงอยู่ใต้ `/api/chat`)
- Produces: `useStream()` → `{ connectionState, subscribe(eventName, callback) }` โดย `connectionState` เป็นหนึ่งใน `'reconnecting' | 'connected' | 'down'` และ `subscribe` คืนฟังก์ชันยกเลิกการสมัคร — Task 3 พึ่งพา `subscribe` ตัวนี้
- Produces: `ChatContext` ยังคงส่งออก `connectionState` เหมือนเดิม เพื่อให้ `web/src/pages/ChatPage.jsx` ใช้ `useChat().connectionState` ได้โดยไม่ต้องแก้

- [ ] **Step 1: สร้าง `web/src/context/StreamContext.jsx`**

โค้ดส่วนใหญ่ยกมาจาก `ChatContext` เดิมตรงๆ ที่เพิ่มใหม่คือ `listenersRef` แบบแยกตามชื่อเหตุการณ์ กับ `STREAM_EVENTS`

```jsx
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from './AuthContext'
import { getStreamTicket } from '../api/chat'

const StreamContext = createContext(null)

// Reconnect backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s. After a handful of
// failed attempts we report `down` instead of `reconnecting` so the banner
// can escalate to the danger palette per the design spec.
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30000
const DOWN_AFTER_ATTEMPTS = 4

// Every named event the server sends on this stream. EventSource has no
// wildcard listener, and the instance is thrown away and rebuilt on every
// reconnect, so subscribers can't be registered against it directly: each new
// connection attaches one dispatcher per name here, while the subscribers
// themselves live in a ref that survives reconnects untouched. A new
// server-side event means adding its name to this list — subscribing to a
// name that isn't here silently never fires.
const STREAM_EVENTS = ['message', 'friend']

// Owns the single SSE connection for the whole app. Chat and Friends both
// subscribe to it rather than each opening their own: one connection per tab,
// and neither context has to depend on the other to get at it.
export function StreamProvider({ children }) {
  const { token } = useAuth()

  const [connectionState, setConnectionState] = useState('reconnecting')

  const listenersRef = useRef(new Map()) // eventName -> Set<(payload) => void>
  const esRef = useRef(null)
  const attemptRef = useRef(0)
  const retryTimerRef = useRef(null)
  const stoppedRef = useRef(true)

  const subscribe = useCallback((eventName, callback) => {
    const map = listenersRef.current
    if (!map.has(eventName)) map.set(eventName, new Set())
    map.get(eventName).add(callback)
    return () => {
      map.get(eventName)?.delete(callback)
    }
  }, [])

  // `scheduleReconnect` and `connect` call each other; a ref sidesteps the
  // definition-order/exhaustive-deps tangle a direct useCallback reference
  // would create between the two.
  const connectRef = useRef(() => {})

  const scheduleReconnect = useCallback(() => {
    if (stoppedRef.current) return
    attemptRef.current += 1
    setConnectionState(attemptRef.current >= DOWN_AFTER_ATTEMPTS ? 'down' : 'reconnecting')
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attemptRef.current - 1))
    clearTimeout(retryTimerRef.current)
    retryTimerRef.current = setTimeout(() => connectRef.current(), delay)
  }, [])

  const connect = useCallback(async () => {
    if (stoppedRef.current) return
    setConnectionState((s) => (s === 'connected' ? s : 'reconnecting'))
    let ticket
    try {
      ;({ ticket } = await getStreamTicket(token))
    } catch {
      scheduleReconnect()
      return
    }
    if (stoppedRef.current) return

    const es = new EventSource(`/api/chat/stream?ticket=${encodeURIComponent(ticket)}`)
    esRef.current = es

    es.onopen = () => {
      attemptRef.current = 0
      setConnectionState('connected')
    }

    for (const eventName of STREAM_EVENTS) {
      es.addEventListener(eventName, (evt) => {
        let payload
        try {
          payload = JSON.parse(evt.data)
        } catch {
          return // ignore malformed payloads
        }
        listenersRef.current.get(eventName)?.forEach((cb) => cb(payload))
      })
    }

    es.onerror = () => {
      es.close()
      if (esRef.current === es) esRef.current = null
      scheduleReconnect()
    }
  }, [token, scheduleReconnect])
  connectRef.current = connect

  useEffect(() => {
    clearTimeout(retryTimerRef.current)
    esRef.current?.close()
    esRef.current = null
    attemptRef.current = 0

    if (!token) {
      stoppedRef.current = true
      setConnectionState('reconnecting')
      return
    }

    stoppedRef.current = false
    connect()

    return () => {
      stoppedRef.current = true
      clearTimeout(retryTimerRef.current)
      esRef.current?.close()
      esRef.current = null
    }
    // Reconnect whenever the session changes (login/logout); `connect` itself
    // is stable enough per-token via its own dependency array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  const value = useMemo(() => ({ connectionState, subscribe }), [connectionState, subscribe])

  return <StreamContext.Provider value={value}>{children}</StreamContext.Provider>
}

export function useStream() {
  const ctx = useContext(StreamContext)
  if (!ctx) throw new Error('useStream must be used within a StreamProvider')
  return ctx
}
```

- [ ] **Step 2: เขียน `web/src/context/ChatContext.jsx` ใหม่ทั้งไฟล์**

แทนที่เนื้อไฟล์เดิมทั้งหมดด้วยโค้ดนี้ ส่วนที่หายไปคือโค้ดการเชื่อมต่อที่ย้ายไป `StreamContext` แล้ว ส่วนที่เหลือ (`handleIncomingMessage`, `subscribeToConversation`, `markConversationRead`, `startChat`, `unreadTotal`) เหมือนเดิมทุกตัวอักษร

```jsx
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from './AuthContext'
import { useStream } from './StreamContext'
import { listConversations, startConversation, markRead as markReadApi } from '../api/chat'

const ChatContext = createContext(null)

export function ChatProvider({ children }) {
  const { token, user } = useAuth()
  // The SSE connection itself lives in StreamContext — chat is one of two
  // subscribers to it now, not its owner. `connectionState` is re-exported
  // below so ChatPage's reconnecting/disconnected banner keeps working
  // unchanged; it reports the shared connection's health, which is the same
  // thing it always meant to the user.
  const { connectionState, subscribe } = useStream()

  const [conversations, setConversations] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const listenersRef = useRef(new Map()) // conversationId -> Set<(payload) => void>
  const userIdRef = useRef(user?.id)
  userIdRef.current = user?.id

  const refreshConversations = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      const data = await listConversations(token)
      setConversations(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    if (!token) {
      setConversations([])
      return
    }
    refreshConversations()
  }, [token, refreshConversations])

  // Thread views subscribe here to receive live messages for the
  // conversation they have open, without the context needing to know
  // anything about the currently-mounted route/component.
  const subscribeToConversation = useCallback((conversationId, callback) => {
    const map = listenersRef.current
    if (!map.has(conversationId)) map.set(conversationId, new Set())
    map.get(conversationId).add(callback)
    return () => {
      map.get(conversationId)?.delete(callback)
    }
  }, [])

  const handleIncomingMessage = useCallback((payload) => {
    listenersRef.current.get(payload.conversationId)?.forEach((cb) => cb(payload))

    setConversations((prev) => {
      const idx = prev.findIndex((c) => c.id === payload.conversationId)
      if (idx === -1) {
        // A message for a conversation we don't have cached yet (e.g. the
        // very first message of a brand-new conversation someone else
        // started with us) — refetch to pick up the new row with its
        // otherUser/unreadCount rather than trying to fabricate it here.
        refreshConversations()
        return prev
      }
      const isMine = payload.senderId === userIdRef.current
      const next = [...prev]
      const conv = next[idx]
      next[idx] = {
        ...conv,
        lastMessage: payload,
        lastMessageAt: payload.createdAt,
        unreadCount: isMine ? conv.unreadCount : conv.unreadCount + 1,
      }
      return next
    })
  }, [refreshConversations])

  useEffect(() => subscribe('message', handleIncomingMessage), [subscribe, handleIncomingMessage])

  const markConversationRead = useCallback(
    async (conversationId) => {
      setConversations((prev) => prev.map((c) => (c.id === conversationId ? { ...c, unreadCount: 0 } : c)))
      try {
        await markReadApi(conversationId, token)
      } catch {
        // Non-critical — the badge may drift until the next full refresh.
      }
    },
    [token]
  )

  const startChat = useCallback(
    async (userId) => {
      const summary = await startConversation(userId, token)
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.id === summary.id)
        if (idx !== -1) {
          const next = [...prev]
          next[idx] = { ...next[idx], otherUser: summary.otherUser, lastMessageAt: summary.lastMessageAt }
          return next
        }
        return [{ ...summary, lastMessage: null, unreadCount: 0 }, ...prev]
      })
      return summary
    },
    [token]
  )

  const unreadTotal = useMemo(
    () => conversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0),
    [conversations]
  )

  const value = useMemo(
    () => ({
      conversations,
      loading,
      error,
      connectionState,
      unreadTotal,
      refreshConversations,
      subscribeToConversation,
      markConversationRead,
      startChat,
    }),
    [
      conversations,
      loading,
      error,
      connectionState,
      unreadTotal,
      refreshConversations,
      subscribeToConversation,
      markConversationRead,
      startChat,
    ]
  )

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}

export function useChat() {
  const ctx = useContext(ChatContext)
  if (!ctx) throw new Error('useChat must be used within a ChatProvider')
  return ctx
}
```

- [ ] **Step 3: ครอบ `StreamProvider` ใน `web/src/App.jsx`**

เพิ่ม import ต่อจากบรรทัด 2 (`import { AuthProvider } from './context/AuthContext'`):

```jsx
import { StreamProvider } from './context/StreamContext'
```

แล้วครอบ provider โดยวาง `StreamProvider` ไว้ใต้ `AuthProvider` (เพราะมันต้องใช้ `token`) และเหนือ `ChatProvider` — บรรทัด 21–22 เดิมกลายเป็น:

```jsx
        <AuthProvider>
          <StreamProvider>
            <ChatProvider>
```

และปิดแท็กให้ครบที่บรรทัด 44–45 เดิม:

```jsx
            </ChatProvider>
          </StreamProvider>
        </AuthProvider>
```

ระวังย่อหน้าของ `<FriendsProvider>` และ `<Routes>` ที่อยู่ข้างในให้เลื่อนตามด้วย

- [ ] **Step 4: ตรวจ lint และ build**

```bash
cd web && npm run lint && npm run build
```

คาดว่า: ผ่านทั้งสอง ถ้า lint ฟ้อง `react-hooks/exhaustive-deps` ที่ effect ตัวสุดท้ายของ `StreamContext` ให้เช็คว่ามีคอมเมนต์ `// eslint-disable-next-line react-hooks/exhaustive-deps` อยู่จริงตามโค้ดใน Step 1 (ยกมาจากไฟล์เดิม)

- [ ] **Step 5: ทดลองใช้จริงว่าแชทยังทำงาน**

นี่คือจุดเสี่ยงหลักของงานย้ายโค้ดนี้ — ต้องยืนยันว่าไม่ทำแชทพัง

```bash
# เทอร์มินัลที่ 1
npm run dev
# เทอร์มินัลที่ 2
cd web && npm run dev
```

เปิดสองเบราว์เซอร์ (หรือหน้าต่างปกติ + หน้าต่างส่วนตัว) ล็อกอินคนละบัญชีที่เป็นเพื่อนกันแล้ว จากนั้นตรวจ:
- ส่งข้อความจาก A → ขึ้นที่ B ทันทีโดยไม่ต้องรีเฟรช
- ตัวเลขข้อความที่ยังไม่อ่านของ B เพิ่มขึ้น
- ปิดเซิร์ฟเวอร์หลัง (เทอร์มินัลที่ 1) → แถบเตือน "reconnecting" ขึ้นในหน้าแชท และเปลี่ยนเป็น "disconnected" หลังพยายามต่อใหม่ 4 ครั้ง
- เปิดเซิร์ฟเวอร์กลับมา → แถบเตือนหาย และส่งข้อความได้สดเหมือนเดิม
- เปิด DevTools แท็บ Network กรอง `stream` → ต้องเห็นการเชื่อมต่อ **เส้นเดียว** ต่อหนึ่งแท็บ ไม่ใช่สองเส้น

- [ ] **Step 6: Commit**

```bash
git add web/src/context/StreamContext.jsx web/src/context/ChatContext.jsx web/src/App.jsx
git commit -m "$(cat <<'EOF'
Extract the SSE connection out of ChatContext into StreamContext

ChatContext owned the EventSource, the ticket fetch and the reconnect
backoff, which left no way for any other context to reach the stream.
StreamContext now owns one connection for the app and hands out
subscribe(eventName, callback); chat is a subscriber to 'message' rather
than the owner, and re-exports connectionState so ChatPage's banner is
untouched.

EventSource has no wildcard listener and its instance is rebuilt on every
reconnect, so subscribers live in a ref and each new connection attaches a
dispatcher per name in STREAM_EVENTS.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: ฝั่งหน้าเว็บ — ให้ `FriendsContext` ฟังเหตุการณ์ `friend`

**Files:**
- Modify: `web/src/context/FriendsContext.jsx` (คอมเมนต์บรรทัด 17–21, import บรรทัด 1–13, และเพิ่ม effect หลัง `refresh`)
- Test: ไม่มีชุดทดสอบฝั่งหน้าเว็บ — ตรวจด้วย lint + build + ทดลองใช้จริง

**Interfaces:**
- Consumes: `useStream()` → `{ subscribe }` จาก Task 2; เหตุการณ์ `"friend"` จาก Task 1
- Produces: ไม่มีของใหม่ที่ task อื่นใช้ — `useFriends()` คืนค่าเหมือนเดิมทุกตัว

- [ ] **Step 1: เพิ่ม import**

ใน `web/src/context/FriendsContext.jsx` เพิ่มต่อจากบรรทัด 2 (`import { useAuth } from './AuthContext'`):

```jsx
import { useStream } from './StreamContext'
```

- [ ] **Step 2: แทนคอมเมนต์ที่ล้าสมัย**

ลบคอมเมนต์เดิมบรรทัด 17–21 (ก้อนที่ขึ้นต้นว่า `// No live push for friend requests yet...`) แล้วใส่แทนด้วย:

```jsx
// Friend requests and acceptances arrive live over the shared SSE stream as
// `friend` events (see StreamContext), on top of the refetch-on-mount and
// refetch-after-every-action this already did. Decline, cancel, unfriend and
// block publish nothing and stay stale-until-refetch — they're out of scope
// deliberately, not missed.
```

- [ ] **Step 3: อ่าน `subscribe` จาก stream**

ใต้บรรทัด `const { token } = useAuth()` เพิ่ม:

```jsx
  const { subscribe } = useStream()
```

- [ ] **Step 4: สมัครรับเหตุการณ์**

เพิ่ม effect นี้ต่อจาก `useEffect` ตัวที่เรียก `refresh()` ตอน mount (ก้อนที่จบด้วย `}, [token, refresh])`):

```jsx
  // Just refetch rather than patching state from the payload: it's two cheap
  // queries, it's the exact function every button handler already calls, and
  // it can't drift from server state the way hand-patched local state can.
  useEffect(() => subscribe('friend', () => refresh()), [subscribe, refresh])
```

`refresh` มี `if (!token) return` อยู่แล้ว จึงไม่ต้องเช็ค token ซ้ำตรงนี้

- [ ] **Step 5: ตรวจ lint และ build**

```bash
cd web && npm run lint && npm run build
```

คาดว่า: ผ่านทั้งสอง

- [ ] **Step 6: ทดลองใช้จริง — จุดสำคัญที่สุดของงานทั้งหมด**

เปิดเซิร์ฟเวอร์ทั้งสองฝั่งเหมือน Task 2 Step 5 แล้วเปิดสองเบราว์เซอร์ ล็อกอินคนละบัญชี ทั้งคู่**เปิดค้างอยู่ที่หน้า `/friends` แล้วอย่าแตะอะไร**

- A ส่งคำขอเป็นเพื่อนไปหา B ด้วยรหัส publicId → คำขอต้องโผล่ในรายการ "ขาเข้า" ของ B **เอง** พร้อมตัวเลขแจ้งเตือน โดย B ไม่ต้องรีเฟรชหรือกดอะไรเลย
- B กดตอบรับ → ฝั่ง A รายการ "ขาส่ง" ต้องหายไปและ B โผล่ในรายชื่อเพื่อน โดย A ไม่ต้องรีเฟรช
- ทดสอบเส้นทางตอบรับอัตโนมัติ: ให้ A ส่งคำขอหา B แล้ว B ส่งคำขอกลับหา A (แทนที่จะกดตอบรับ) → ทั้งคู่ต้องเห็นว่าเป็นเพื่อนกันแล้วทันที
- ตรวจว่าแชทยังสดอยู่พร้อมกัน: ระหว่างที่ทั้งคู่ยังเปิดค้าง ส่งข้อความไปมา → ต้องยังขึ้นทันทีเหมือนเดิม
- ตรวจว่าไม่พังตอนออกจากระบบ: กด logout แล้ว login ใหม่ → คำขอเป็นเพื่อนยังมาสดเหมือนเดิม (พิสูจน์ว่าการสมัครรับเหตุการณ์รอดข้ามการต่อสายใหม่)

- [ ] **Step 7: Commit**

```bash
git add web/src/context/FriendsContext.jsx
git commit -m "$(cat <<'EOF'
Refresh the friends list live on incoming friend events

FriendsContext refetched only on mount and after an action taken through
it, so a request arriving while the tab sat open and idle stayed invisible
until something else triggered a refetch. It now subscribes to the shared
stream's 'friend' events and calls the same refresh() every button handler
already used.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: อัปเดต `CLAUDE.md`

Roadmap #1 ทำเสร็จแล้ว ต้องเอาออก เลื่อนเลขข้ออื่น และแก้ทุกที่ที่อ้างถึงเลขเดิมหรือบรรยายว่า "ยังไม่มี live stream"

**Files:**
- Modify: `CLAUDE.md` (บรรทัด 58, 61, 64, 66, 75–77, 83)

**Interfaces:**
- Consumes: ผลลัพธ์จาก Task 1–3 ทั้งหมด
- Produces: ไม่มี — เป็นงานเอกสารล้วน

- [ ] **Step 1: เพิ่มคำอธิบาย `StreamContext` ในหัวข้อ SSE**

ในบรรทัด 61 (bullet ที่ขึ้นต้นว่า `- Live delivery is SSE:`) เติมข้อความนี้ต่อท้าย bullet เดิม:

```
 On the client the connection itself lives in `web/src/context/StreamContext.jsx`, not in any one feature's context: it owns the ticket fetch, the `EventSource`, the reconnect backoff and the `connected`/`reconnecting`/`down` state, and hands out `subscribe(eventName, callback)`. `ChatContext` subscribes to `message` and `FriendsContext` to `friend`, so one tab holds one connection and neither context has to depend on the other to reach it. `EventSource` has no wildcard listener and its instance is rebuilt on every reconnect, so subscribers are held in a ref and each new connection attaches one dispatcher per name in `STREAM_EVENTS` — a new server-side event name has to be added to that list or nothing will ever hear it. `ChatContext` re-exports `connectionState` unchanged, which is what `ChatPage`'s reconnect banner still reads.
```

- [ ] **Step 2: แก้ย่อหน้า push ที่บอกว่า Friends ไม่มี stream**

ในบรรทัด 66 หาข้อความนี้:

```
Friend-request notifications (`src/routes/friends.js#notify`) are simpler but *not* symmetric with chat's gating: they fire unconditionally rather than checking `chatBus.hasSubscribers`, because that would only tell you the recipient has a *chat* stream open, not that they've seen the request — `FriendsContext` has no live stream of its own to check against (see Roadmap).
```

แทนที่ด้วย:

```
Friend-request notifications (`src/routes/friends.js#notify`) are *not* symmetric with chat's gating: they fire unconditionally rather than checking `chatBus.hasSubscribers`. Friends does ride the shared stream now (`notify` publishes a `friend` event alongside the push), but an open stream only means the tab is connected — not that the person has seen the request; they may be on another route entirely, or the tab may be backgrounded. So unlike a chat message, the push is not redundant with the live event and both always fire.
```

- [ ] **Step 3: เอา Roadmap ข้อ 1 ออกและเลื่อนเลข**

แทนที่บรรทัด 75–77 ทั้งสามข้อด้วยสองข้อนี้ (เนื้อหาเดิมของข้อ 2 และ 3 ไม่เปลี่ยน เปลี่ยนแค่เลข):

```markdown
1. **Reading pruned history back out of Drive.** Once `pruneArchivedMessages()` deletes a message from Postgres, it only lives in each participant's own Drive file — there is no in-app "load older messages from Drive" for `GET /conversations/:id/messages` to fall back to, so very old history is effectively export-only (a user can open the JSONL file in Drive directly, but not scroll to it in the chat UI). Building that would mean the currently-logged-in user's own Drive access token being available live in-session (today it's only ever used server-side, briefly, during the cron sweep) and merging their Drive-backed pages with Postgres's live tail.
2. **A `role`/permission field on `User`.** Not needed yet — every account can do the same things in this app — but if any admin-style capability is ever added, it should be scoped to "what can this account do in *this* app," not resurrect the old shop app's admin/staff distinction.
```

- [ ] **Step 4: แก้การอ้างเลข Roadmap ที่เลื่อนไป**

สองจุดนี้ชี้ไปที่ข้อ "role field" ซึ่งเลื่อนจาก #3 เป็น #2:

บรรทัด 58 — เปลี่ยน `because Roadmap #3 will need exactly this pattern` เป็น:

```
because Roadmap #2 will need exactly this pattern
```

บรรทัด 83 — เปลี่ยน `once a role field actually exists again (see Roadmap #3).` เป็น:

```
once a role field actually exists again (see Roadmap #2).
```

- [ ] **Step 5: แก้การอ้าง Roadmap ที่เสียอยู่ก่อนแล้วในหัวข้อ signup**

บรรทัด 64 เขียนว่า `It is explicitly **not** meant to be the production signup flow; see Roadmap #1.` — การอ้างนี้**ผิดอยู่ก่อนแล้ว** ไม่เกี่ยวกับงานนี้: Roadmap #1 เดิมคือ live friend-request updates ไม่ใช่เรื่อง signup และไม่เคยมีข้อไหนใน Roadmap พูดถึง production signup flow เลย ตอนนี้ยิ่งต้องแก้เพราะข้อ 1 หายไปแล้ว

เปลี่ยนประโยคนั้นเป็น (ตัดการอ้างเลขทิ้ง เพราะไม่มีข้อไหนให้ชี้):

```
It is explicitly **not** meant to be the production signup flow — email verification, CAPTCHA and abuse controls all still have to be designed, and none of them are on the Roadmap below yet.
```

- [ ] **Step 6: ตรวจว่าไม่มีการอ้าง Roadmap ที่ค้างอยู่**

```bash
grep -n "Roadmap" CLAUDE.md
```

คาดว่า: ทุกบรรทัดที่ออกมาต้องชี้ไปที่ข้อที่มีอยู่จริง (ตอนนี้เหลือ #1 กับ #2 เท่านั้น) และต้องไม่มีคำว่า `Roadmap #3` เหลืออยู่ และต้องไม่มีข้อความไหนยังบอกว่า friend requests ไม่มี live update

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
Update CLAUDE.md for live friend-request updates

Roadmap #1 is done, so it's removed and the remaining two renumbered,
along with the references pointing at them. Documents StreamContext as
the owner of the client's single SSE connection, and corrects the push
section, which still claimed Friends had no live stream to check against.

Also fixes a pre-existing bad reference: the signup bullet cited
"Roadmap #1" for a production signup flow, but no roadmap item has ever
covered that.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## ตรวจครั้งสุดท้ายหลังทำครบทุก task

- [ ] `npm test` ผ่านทั้งหมด
- [ ] `cd web && npm run lint && npm run build` ผ่านทั้งสอง
- [ ] `git status` สะอาด
- [ ] เปิดสองเบราว์เซอร์ค้างที่หน้า `/friends` ทั้งคู่: ส่งคำขอแล้วเห็นทันที ตอบรับแล้วเห็นทันที และแชทยังส่งสดได้พร้อมกัน
- [ ] DevTools แท็บ Network: หนึ่งแท็บมีสาย `stream` เส้นเดียว

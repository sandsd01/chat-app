# Chat

A standalone 1:1 direct-messaging app. You add someone as a friend by sharing your
account's short public ID, then message them, with messages delivered live over
Server-Sent Events (SSE).

This is phase 5: email+password accounts (self-signup) or Google sign-in, the
add-by-ID friend system that gates who can message whom, and the app is
installable (PWA) with Web Push notifications for messages that arrive while
it isn't open. See `CLAUDE.md` for the architectural reasoning behind what's
here.

## Stack

- **Backend**: Node.js + Express 5 (`src/`), Prisma ORM + PostgreSQL via `@prisma/adapter-pg` (`prisma/`)
- **Frontend**: React + Vite SPA (`web/`)
- **Auth**: JWT (`Authorization: Bearer <token>`)
- **Real-time**: Server-Sent Events, authorized by a short-lived single-use ticket
- **Tests**: `node:test` + Supertest (`tests/`) against a dedicated PostgreSQL test database

## Setup

```bash
npm install                 # also runs `prisma generate` via postinstall
cp .env.example .env        # fill in DATABASE_URL and JWT_SECRET at minimum
npx prisma migrate deploy   # apply prisma/migrations to the database in DATABASE_URL
npm run seed                # seed two local dev accounts, already friends (alice/bob, see .env.example)
npm run dev                 # run the backend with auto-restart (http://localhost:3000)
npm test                    # migrate the test database, then run the full backend suite
```

Frontend (`cd web` first):

```bash
npm install
npm run dev     # http://localhost:5173, proxies /api/* to the backend
npm run build   # production build, also run in CI
```

In production (and via `npm run dev:fresh` locally) `src/app.js` serves the built
`web/dist` from the same origin as the API, so there is no separate frontend
deployment or CORS configuration needed by default.

## API

All routes are namespaced under `/api`.

### Auth

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/signup` | — | Create an account (email + password, 8+ chars); returns a JWT and the user, including their generated `publicId` |
| POST | `/api/auth/login` | — | Email + password login; `401` with a clear message if the account is Google-only (no password set) |
| GET | `/api/auth/google` | — | Starts Google sign-in: sets a CSRF state cookie and redirects to Google's consent screen; `503` if not configured |
| GET | `/api/auth/google/callback` | — | Google redirects the browser back here; on success redirects to `${APP_URL}/oauth-callback?ticket=` (a single-use, 30-second ticket — never the real JWT in a URL), on failure to `${APP_URL}/login?error=` |
| POST | `/api/auth/google/exchange` | — | Exchange the callback's ticket for a real JWT + user, `{ ticket }` → `{ token, user }` |
| GET | `/api/auth/me` | required | The caller's own profile |
| POST | `/api/auth/logout` | — | No-op; the client just discards the token |
| PATCH | `/api/auth/password` | required | Change your own password |
| POST | `/api/auth/forgot-password` | — | Request a reset link (always a generic response, to avoid account enumeration) |
| POST | `/api/auth/reset-password` | — | Reset with a valid, unexpired token |
| DELETE | `/api/users/me` | required | Delete your own account (`409` if you have chat history) |

Signing in with Google auto-links to an existing password account with the
same (Google-verified) email, rather than creating a second account — one
person, one account, whichever way they signed in. A Google-only account has
no password (`PATCH /auth/password` `400`s on it, "This account signs in with
Google and has no password to change") until it also completes a password
reset, which sets one.

### Friends

You must be friends with someone (an accepted `Friendship` row) before you can start
a conversation or send them a message.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/friends/lookup?publicId=` | required | Look up an account by its exact public ID; includes `relationship` (`none`/`requestSent`/`requestReceived`/`friends`/`blocked`) |
| GET | `/api/friends` | required | Your accepted friends |
| GET | `/api/friends/requests` | required | Your pending requests, split into `incoming`/`outgoing` |
| POST | `/api/friends/requests` | required | Send a request with `{ publicId }` — if they'd already requested you, this accepts instead of creating a second pending row |
| POST | `/api/friends/requests/:id/accept` | required | Accept an incoming request |
| POST | `/api/friends/requests/:id/decline` | required | Decline an incoming request (deletes the row, so they can try again later) |
| DELETE | `/api/friends/requests/:id` | required | Cancel your own outgoing request |
| DELETE | `/api/friends/:userId` | required | Remove an accepted friend |
| POST | `/api/friends/:userId/block` | required | Block an account (also removes any existing friendship) |
| POST | `/api/friends/:userId/unblock` | required | Undo your own block |

### Chat

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/chat/conversations` | required | Your own conversations, most recently active first |
| POST | `/api/chat/conversations` | required | Find-or-create a 1:1 conversation with `{ userId }` — `403` if you're not friends, `201` new, `200` existing |
| GET | `/api/chat/conversations/:id/messages?before=&limit=` | required | Newest-first page of messages, `{ data, hasMore, nextBefore }` |
| POST | `/api/chat/conversations/:id/messages` | required | Send a message (`{ body }`, 1–4000 characters) — `403` if you're no longer friends with the other participant |
| POST | `/api/chat/conversations/:id/read` | required | Mark the conversation read up to now |
| POST | `/api/chat/stream-ticket` | required | Mint a single-use, 30-second ticket for the SSE stream below |
| GET | `/api/chat/stream?ticket=` | ticket only | SSE stream of `message` (and `friend`) events for your own conversations/account |

A conversation is visible only to its two participants — every `/api/chat/conversations/:id/*`
route answers `404` (not `403`) to anyone else, and there is no override for reading
someone else's messages. Message history stays readable after unfriending; only
sending new messages is blocked.

### Push notifications

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/push/vapid-public-key` | required | The server's VAPID public key, for `PushManager.subscribe()`; `503` if push isn't configured (no `VAPID_*` env vars) |
| POST | `/api/push/subscribe` | required | Register a browser's `PushSubscription` (`{ subscription: { endpoint, keys: { p256dh, auth } } }`) — upserts on `endpoint`, so re-subscribing the same browser replaces rather than duplicates |
| POST | `/api/push/unsubscribe` | required | Remove your own subscription by `{ endpoint }` |

A new chat message triggers a push **only** to a recipient with no live SSE
connection open — someone with the app open in a tab gets the message over
SSE and never sees a redundant OS notification for it. Push is a best-effort
fallback for "not connected right now," not a mirror of every SSE event; see
`CLAUDE.md` for the reasoning and for why friend-request notifications work
slightly differently.

## Environment variables

See `.env.example` for the full list with explanations. `DATABASE_URL` and
`JWT_SECRET` are required; the server refuses to start without them (and refuses a
placeholder or short `JWT_SECRET`). Everything else is optional.

## Google sign-in

Optional — see `.env.example` for `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI`.
Without them, `GET /api/auth/google` `503`s and the "Continue with Google"
link on the login/signup pages leads to that; email+password still works
either way. `GOOGLE_REDIRECT_URI` must match one of the OAuth client's
"Authorized redirect URIs" in Google Cloud Console *exactly*, and while the
consent screen is in Testing mode, only accounts explicitly added as test
users can complete sign-in.

## PWA

`web/public/manifest.webmanifest`, `web/public/sw.js`, and the icons under
`web/public/icons/` make the app installable ("Add to Home Screen" / desktop
install prompt). The service worker registers unconditionally on load — that
part needs no user action — but it deliberately does **not** cache the app
shell for offline use; it exists only for installability and to receive push
while no tab is open. A logged-in user opts into push separately from the
Account page (`Enable notifications`), which is the one part that needs an
explicit gesture and browser permission grant.

**iOS note**: Safari only supports Web Push for a PWA that's actually been
added to the Home Screen (iOS 16.4+) — opening the site in a normal Safari tab
and granting notification permission there does nothing on iOS.

## Deployment

`Dockerfile` builds a single production image (SPA + API in one container) and
`render.yaml` is a ready-to-use Render Blueprint. **Read the comment block at the
top of `render.yaml` before scaling this service** — real-time delivery depends on
running exactly one instance (see `CLAUDE.md`).

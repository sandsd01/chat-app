# Chat

A standalone 1:1 direct-messaging app. You add someone as a friend by sharing your
account's short public ID, then message them, with messages delivered live over
Server-Sent Events (SSE).

This is phase 2: email+password accounts (self-signup) plus the add-by-ID friend
system that gates who can message whom. Not yet built (tracked as later phases):
Google sign-in, a PWA manifest + service worker + Web Push, and per-user Google
Drive message archiving. See `CLAUDE.md` for the architectural reasoning behind
what *is* here.

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
| POST | `/api/auth/login` | — | Email + password login |
| GET | `/api/auth/me` | required | The caller's own profile |
| POST | `/api/auth/logout` | — | No-op; the client just discards the token |
| PATCH | `/api/auth/password` | required | Change your own password |
| POST | `/api/auth/forgot-password` | — | Request a reset link (always a generic response, to avoid account enumeration) |
| POST | `/api/auth/reset-password` | — | Reset with a valid, unexpired token |
| DELETE | `/api/users/me` | required | Delete your own account (`409` if you have chat history) |

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
| GET | `/api/chat/stream?ticket=` | ticket only | SSE stream of `message` events for your own conversations |

A conversation is visible only to its two participants — every `/api/chat/conversations/:id/*`
route answers `404` (not `403`) to anyone else, and there is no override for reading
someone else's messages. Message history stays readable after unfriending; only
sending new messages is blocked.

## Environment variables

See `.env.example` for the full list with explanations. `DATABASE_URL` and
`JWT_SECRET` are required; the server refuses to start without them (and refuses a
placeholder or short `JWT_SECRET`). Everything else is optional.

## Deployment

`Dockerfile` builds a single production image (SPA + API in one container) and
`render.yaml` is a ready-to-use Render Blueprint. **Read the comment block at the
top of `render.yaml` before scaling this service** — real-time delivery depends on
running exactly one instance (see `CLAUDE.md`).

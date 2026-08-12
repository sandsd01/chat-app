# Chat

A standalone 1:1 direct-messaging app. Any registered user can search for another
user and message them, with messages delivered live over Server-Sent Events (SSE).

This is phase 1: text-only 1:1 messaging with email+password accounts. Not yet built
(tracked as later phases): Google sign-in / self-signup, a friend/add-by-ID system
gating who can message whom, a PWA manifest + service worker + Web Push, and
per-user Google Drive message archiving. See `CLAUDE.md` for the architectural
reasoning behind what *is* here.

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
npm run seed                # seed two local dev accounts (alice/bob, see .env.example)
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

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/login` | — | Email + password login, returns a JWT and the user |
| GET | `/api/auth/me` | required | The caller's own profile |
| POST | `/api/auth/logout` | — | No-op; the client just discards the token |
| PATCH | `/api/auth/password` | required | Change your own password |
| POST | `/api/auth/forgot-password` | — | Request a reset link (always a generic response, to avoid account enumeration) |
| POST | `/api/auth/reset-password` | — | Reset with a valid, unexpired token |
| DELETE | `/api/users/me` | required | Delete your own account (`409` if you have chat history) |
| GET | `/api/chat/users?q=` | required | Search other users by name or email (case-insensitive, max 20); never returns yourself |
| GET | `/api/chat/conversations` | required | Your own conversations, most recently active first |
| POST | `/api/chat/conversations` | required | Find-or-create a 1:1 conversation with `{ userId }` — `201` new, `200` existing |
| GET | `/api/chat/conversations/:id/messages?before=&limit=` | required | Newest-first page of messages, `{ data, hasMore, nextBefore }` |
| POST | `/api/chat/conversations/:id/messages` | required | Send a message (`{ body }`, 1–4000 characters) |
| POST | `/api/chat/conversations/:id/read` | required | Mark the conversation read up to now |
| POST | `/api/chat/stream-ticket` | required | Mint a single-use, 30-second ticket for the SSE stream below |
| GET | `/api/chat/stream?ticket=` | ticket only | SSE stream of `message` events for your own conversations |

A conversation is visible only to its two participants — every `/api/chat/conversations/:id/*`
route answers `404` (not `403`) to anyone else, and there is no override for reading
someone else's messages.

## Environment variables

See `.env.example` for the full list with explanations. `DATABASE_URL` and
`JWT_SECRET` are required; the server refuses to start without them (and refuses a
placeholder or short `JWT_SECRET`). Everything else is optional.

## Deployment

`Dockerfile` builds a single production image (SPA + API in one container) and
`render.yaml` is a ready-to-use Render Blueprint. **Read the comment block at the
top of `render.yaml` before scaling this service** — real-time delivery depends on
running exactly one instance (see `CLAUDE.md`).

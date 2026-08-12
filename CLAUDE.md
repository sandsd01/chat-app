# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A standalone 1:1 direct-messaging app (phase 1 of a larger plan — see below). Any
registered user can message any other; there are no roles, groups, or admin
overrides. See `README.md` for setup, the API endpoint table, and available scripts.

- **Backend**: Node.js + Express 5 (`src/`), Prisma ORM + PostgreSQL via `@prisma/adapter-pg` (`prisma/`)
- **Frontend**: React + Vite SPA (`web/`)
- **Auth**: JWT (`Authorization: Bearer <token>`) — email + password only for now
- **Tests**: `node:test` + Supertest (`tests/`) against a dedicated PostgreSQL test database

## History: ported from a POS/inventory app

This code started as a chat feature bolted onto an existing inventory/POS system
(`sandsd01/sandsd01`), reusing that app's `User`/auth. Once the owner decided chat
should be a public, standalone product with self-signup, it was split out into this
repository — a chat app and a shop's back office are different products with
different users and shouldn't share deploys, roles, or a database. This repo is the
result of that split: the chat feature carried over essentially unchanged (routes,
schema, SSE design), while every shop-specific concept (roles, branches, sales,
inventory) was dropped rather than ported. If you find a comment or pattern that
seems to assume "staff vs admin" and it's gone, that's why — there is no role
system in this app yet (see Roadmap below for when one returns, and why it will
mean something different this time).

## Commands

```bash
npm install                 # also runs `prisma generate` via postinstall
npx prisma migrate deploy   # apply prisma/migrations to the database in DATABASE_URL
npm run seed                # seed two local dev accounts
npm run dev                 # run the backend with auto-restart (http://localhost:3000)
npm test                    # migrate the test database, then run the full backend suite
```

To run a single backend test file: `DATABASE_URL="$TEST_DATABASE_URL" JWT_SECRET="test-secret" NODE_ENV="test" node --test tests/chat.test.js` (run `npm run test:migrate` first). `tests/helpers/db.js` defaults `DATABASE_URL` to the local `chatapp_test` database when it isn't already set.

Frontend (`cd web` first):

```bash
npm install
npm run dev     # http://localhost:5173, proxies /api/* to the backend
npm run build   # production build, also run in CI
```

## Architecture

- `src/app.js` wires up Express routes and middleware; `src/server.js` is the actual process entry point (reads env, calls `app.listen`) — tests import `app.js` directly and never start a real listener. All API routers are mounted under `/api`, because `src/app.js` also serves the built SPA from `web/dist` when it exists: a client-side route like `/chat/42` would otherwise resolve to the API router and return JSON to a browser asking for a page. The SPA fallback serves `index.html` for any GET that isn't under `/api` or `/health`, so an unknown API path still returns the JSON 404 rather than HTML a `fetch()` caller can't parse. `web/vite.config.js` proxies `/api` **without rewriting it**, so dev and a single-origin production deploy see identical paths — don't reintroduce a prefix-stripping rewrite. `helmet` sets the security headers; CORS is off by default in production and enabled only via `CORS_ORIGIN` for a separately-hosted frontend. `TRUST_PROXY` must be set when running behind a load balancer, or `express-rate-limit` buckets every client under the proxy's IP.
- `src/middleware/auth.js`: `authenticate` verifies the JWT and attaches `req.user`; `requireRole(...roles)` exists but is currently unused (no route calls it) — there is no role system yet. It's kept rather than deleted because the roadmap's "friends-gated, chat-only public accounts" phase will need exactly this pattern; don't reach for it before that phase actually adds a `role` field to `User`.
- `prisma/client.js` is the single shared Prisma Client instance (constructed with the pg driver adapter; it throws at require time if `DATABASE_URL` is unset) — routes and scripts require this rather than instantiating their own client.
- Chat (`src/routes/chat.js`, mounted at `/api/chat`, `Conversation` + `Message`) is 1:1 direct messaging. A conversation stores its pair as `userAId`/`userBId` **canonically ordered by the backend** (`userAId = Math.min(me, target)`, `userBId = Math.max(...)`), which is what turns `@@unique([userAId, userBId])` into an idempotent find-or-create — `POST /conversations` returns `201` on create and `200` on the existing row no matter who initiates — with no participants join table to reason about. The database does **not** enforce that ordering, so any new write path must canonicalise the pair itself or it will create a duplicate mirrored row. Unread state is two nullable timestamps on the conversation (`userALastReadAt`/`userBLastReadAt`, bumped by `POST /conversations/:id/read`) with `unreadCount` counted from them, deliberately instead of a per-message read-receipts table: "never read" is simply a null, and a reader only ever writes their own column. `GET /conversations/:id/messages` pages newest-first on a `before` message-id cursor, fetching `limit + 1` rows to derive `hasMore` without a second count query.
- Live delivery is SSE: `POST /stream-ticket` mints a single-use, 30-second ticket kept in process memory, and `GET /api/chat/stream?ticket=` is registered **before `router.use(authenticate)`** on purpose — `EventSource` cannot send an `Authorization` header, and putting the real JWT in a query string would leak it into access logs and `Referer`, so don't "tidy" the stream back under the JWT middleware. `src/lib/chatBus.js` is a plain in-process `EventEmitter`, correct only while the app runs as exactly one instance; running multiple instances (or cluster mode) needs every publish fanned out via Redis pub/sub or equivalent — it does not do that today. See the `SINGLE INSTANCE ONLY` comment block at the top of `render.yaml` before ever adding a `numInstances`/`scaling` key.
- Three privacy choices are intentional, not oversights: a non-participant gets **404, not 403** on any conversation-scoped route, there is **no admin override** for reading other people's DMs (there is no admin at all), and message bodies are **never** logged anywhere — this app has no audit-log table, on purpose, because chat content doesn't belong in one.
- `DELETE /users/me` 409s if the caller is in any conversation or has sent any message, the same "refuse rather than orphan" pattern you'd see guarding any FK-linked delete — a DM thread has no "detach and keep going" story. There is no route to delete *another* user's account; the only actor here is the account itself.
- Money/Decimal handling, S3-compatible upload storage, audit logging, VAT/tax, cash-shift reconciliation, and role-based access do **not** exist in this app — they were part of the shop app this was split from and were deliberately not carried over. If you're tempted to add one of these because it "seems missing," check the Roadmap below first; it's very likely out of scope rather than forgotten.

## Roadmap (not yet implemented)

These are planned next phases, mentioned here so their absence isn't mistaken for an oversight:

1. **Google sign-in + public self-signup.** Users will be able to create an account via Google OAuth without an admin provisioning them first. This is the point at which a `role` (or similar) field returns to `User` — but scoped to "what can this account do in *this* app" (i.e. gating chat-only access for some accounts), not the admin/staff distinction from the old shop app.
2. **Friend/add-by-ID gating.** `POST /chat/conversations` and `GET /chat/users` will be restricted to require a mutual friend relationship first, with a public shareable user ID distinct from the numeric primary key (so ids aren't guessable/enumerable). Until this ships, any authenticated user can message any other — that's intentional for phase 1's closed set of manually-created accounts, and will change once signup is public.
3. **PWA + Web Push.** A manifest, service worker, install-to-home-screen, and Web Push (VAPID) so a message can notify a user who has no live SSE connection open. Push should be the fallback for "not connected," not a duplicate of every SSE event.
4. **Per-user Google Drive archive.** The server will keep messages in Postgres only as a short rolling buffer for delivering to offline recipients; each user's client will sync their own copy of their conversations into their own Drive (via the `drive.file` OAuth scope, which doesn't require Google's restricted-scope security assessment), and the server will prune once both participants have archived a message. Sync state, conflict handling for multi-device writes, and the prune job are all still to be designed.

## Conventions

- Backend and frontend are separate npm projects (root `package.json` vs `web/package.json`) with independent dependencies and CI jobs.
- Never commit `.env` (gitignored) — use `.env.example` as the template for required environment variables.
- New backend routes needing role restriction should reuse `requireRole` rather than checking `req.user.role` ad hoc, once a role field actually exists again (see Roadmap #1).

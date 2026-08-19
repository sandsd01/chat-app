# Link previews — design

Status: approved 2026-08-19. Feature 8 of the 8-item backlog deferred by the
2026-08-18 audit (the other seven have shipped).

## Problem

A URL pasted into a message renders as inert plain text today —
`web/src/pages/ChatPage.jsx` renders `{m.body}` directly, so a link is neither
clickable nor described. This adds an unfurled preview card (title,
description, site name, thumbnail) under the bubble, plus plain linkification
of URLs in the body.

The feature's whole risk profile lives in one place: the server makes an
outbound HTTP request to a URL an unauthenticated-to-us third party chose.
That is a server-side request forgery (SSRF) primitive unless it is fenced
carefully, and this app runs on a PaaS where a link-local metadata endpoint
(`169.254.169.254`) hands out cloud credentials to anything that can reach it.
The fetcher, not the UI, is the substance of this design.

## Decisions taken up front

- **Thumbnails are fetched server-side and stored, not hotlinked.**
  `src/app.js` sets `img-src 'self' data: blob:`, so a third-party image URL
  would be blocked by CSP outright. Widening it to `https:` was considered and
  rejected: it would leak every reading user's IP address to whatever host the
  *sender* chose, which is exactly the kind of passive deanonymisation this
  app avoids elsewhere. Storing the bytes keeps CSP untouched and means the
  browser never talks to the third party at all. Postgres `bytea` is the store
  because this app has no blob storage (the R2 work is blocked upstream on a
  payment method); a 200 KB cap keeps that defensible.
- **A preview is never refetched.** It is a snapshot of what the link looked
  like when it was shared, which is the semantics a chat log wants. This also
  removes cache invalidation from scope entirely.
- **Failures are cached too** (`status = "failed"`), so a dead or hostile link
  costs one fetch, not one per share.

## Schema

```prisma
model LinkPreview {
  id            Int      @id @default(autoincrement())
  url           String   @unique @db.VarChar(2048)
  status        String   // "ok" | "failed"
  title         String?
  description   String?  @db.Text
  siteName      String?
  imageData     Bytes?
  imageMimeType String?
  fetchedAt     DateTime @default(now())

  messages Message[]
}
```

`Message` gains `linkPreviewId Int?` plus the relation.

`url` is `VarChar(2048)`, not `Text`: a btree unique index cannot cover values
past roughly 2704 bytes, so an unbounded column would let a long URL fail the
insert at runtime rather than at validation time. 2048 is the conventional URL
ceiling and is enforced in application code before the row is ever written.

The unique key on `url` makes the table a shared cache across messages and
across users — the same link shared ten times is fetched once. Sharing rows
this way leaks nothing between conversations: the row holds only public web
content, and the route that serves it is conversation-scoped (below).

## `src/lib/safeFetch.js` — the SSRF fence

Built on `node:http`/`node:https` `request()` rather than `fetch()`, for one
specific reason: `request()` accepts a `lookup` option. Passing a guarded
resolver there means the socket connects to an address that has already been
validated, and TLS SNI plus the `Host` header still derive from the real URL
automatically.

The obvious alternative — resolve the hostname, check the address, then call
`fetch(url)` — is wrong, and the difference is not theoretical. Between the
check and the fetch, the attacker's DNS server can answer again with
`127.0.0.1`. That is DNS rebinding, and guarding `lookup` is what closes the
window rather than narrowing it.

Every request must clear all of:

1. **Scheme** — `http:` or `https:`. Nothing else; `file:`, `gopher:`, and
   friends never reach the socket layer.
2. **Port** — 80 or 443 only, whether default or explicit.
3. **Address** — *every* address DNS returns is checked, not just the first.
   Blocked ranges:
   - IPv4: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10` (CGNAT), `127.0.0.0/8`,
     `169.254.0.0/16` (link-local, and with it the cloud metadata endpoint),
     `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.0/24`,
     `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`,
     `224.0.0.0/4`, `240.0.0.0/4`, `255.255.255.255`.
   - IPv6: `::`, `::1`, `fc00::/7` (ULA), `fe80::/10` (link-local),
     `ff00::/8` (multicast), `64:ff9b::/96` (NAT64), `100::/64`,
     `2001:db8::/32`.
   - IPv4-mapped IPv6 (`::ffff:0:0/96`) is unwrapped and re-checked against
     the IPv4 list. Skipping this is the single most common way an otherwise
     complete blocklist gets bypassed — `::ffff:127.0.0.1` is loopback wearing
     a different notation.
4. **Redirects** — not followed automatically (raw `request()` does not), so
   they are followed deliberately: at most 3 hops, and each hop's URL runs the
   full check above from scratch. A 302 to `http://169.254.169.254/` is the
   whole attack, and it is only stopped by re-validating rather than trusting
   the origin URL's clearance.
5. **Budgets** — 3 s to connect, 5 s total, and a 512 KB response cap enforced
   by destroying the socket once exceeded rather than by trusting
   `Content-Length`.
6. **Content type** — `text/html` or `application/xhtml+xml` for the document
   fetch.

No cookies and no `Authorization` header are ever sent. The `User-Agent`
identifies the app as a preview bot so site operators can see what it is.
Preview resolution is rate-limited per user.

The image fetch reuses the same fence with a different content-type
allowlist — `image/png`, `image/jpeg`, `image/webp`, `image/gif` — and a
200 KB cap. **SVG is excluded**, matching the reasoning the 2026-08-18 audit
already applied to attachment downloads: an SVG is a script-carrying document,
not an inert image.

## `src/lib/linkPreview.js` — metadata extraction

Reads at most the first 128 KB of the document and pulls, in order of
preference, `og:title` / `og:description` / `og:site_name` / `og:image`,
falling back to `<title>` and `<meta name="description">`. HTML entities in
the extracted values are decoded.

This is a focused hand-rolled extractor rather than a parser dependency such
as cheerio, matching the choice `src/lib/drive.js` already made in calling the
Drive REST API directly instead of pulling in `googleapis`: a handful of tags
does not justify a general-purpose DOM.

An `og:image` URL is resolved against the document's final (post-redirect) URL
so relative paths work, then fetched through the same fence.

## Wiring into the existing flow

- **Send** (`POST /conversations/:id/messages`) — extract the first URL from
  the body, respond `201` immediately, then resolve the preview
  fire-and-forget. This copies the push-notification pattern already at
  `src/routes/chat.js:593` verbatim, and for the same reason: a slow third
  party must never delay the response the sender is waiting on. When
  resolution finishes, publish a new `link-preview` SSE event to both
  participants; the card appears a moment after the bubble.
- **Edit** (`PATCH .../messages/:messageId`) — if the first URL in the new
  body differs from the one currently attached, clear `linkPreviewId` and
  resolve the new one. Editing a URL out of a message must not leave its card
  behind.
- **Delete** (`DELETE .../messages/:messageId`) — clear `linkPreviewId`
  alongside `body` and the attachment fields, consistent with that route's
  existing refusal to leave content sitting in a soft-deleted row.
- **Read** (`GET .../messages`) — include the joined preview per message.
- **Drive archive and prune** — untouched. A preview is derived, decorative
  data, so it is not written into the JSONL archive, and
  `pruneArchivedMessages` continues to hard-delete messages freely because the
  foreign key points from `Message` to `LinkPreview`, never the reverse.
  Orphaned `LinkPreview` rows are left behind deliberately: the table is a
  cache, and reaping it would add a sweep for no user-visible benefit.

## Image route

```
GET /api/chat/conversations/:id/messages/:messageId/link-preview-image
```

Deliberately conversation-scoped rather than a global
`/link-previews/:id/image`. Scoping it this way inherits
`getConversationForParticipant` and this app's 404-not-403 convention for free,
and it avoids handing anyone a sequential id space they could walk to learn
which URLs have been shared on the instance — a small leak, but the same class
of leak that `publicId` exists to prevent.

## Frontend

- `web/src/lib/linkify.jsx` — splits a body into text and link segments,
  rendering links with `target="_blank" rel="noopener noreferrer"`.
- `web/src/components/LinkPreviewCard.jsx` — the card rendered under a bubble.
- `web/src/context/ChatContext.jsx` — a `subscribeToLinkPreview` registry
  built on the existing `subscribeViaMap` helper, fed by the new SSE event.
- `web/src/pages/ChatPage.jsx` — render the card, handle the live event.
- Translation keys in both locales.

## Testing

- The address predicate is a pure exported function and is unit-tested
  exhaustively: every blocked range above, IPv4-mapped IPv6, and the
  public addresses that must still pass.
- Redirect chains, scheme rejection, port rejection, the size cap, and the
  content-type check are tested against the fence directly.
- Metadata extraction is unit-tested, including entity decoding and the
  fallback ladder.
- Route-level integration tests stub `resolveLinkPreview`. There is
  deliberately no `LINK_PREVIEW_ALLOW_PRIVATE` style escape hatch: an env flag
  that disables the SSRF fence is a production incident waiting for the day
  someone sets it in the wrong environment.

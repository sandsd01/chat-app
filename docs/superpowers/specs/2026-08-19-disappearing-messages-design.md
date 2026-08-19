# Disappearing messages — design

Status: approved 2026-08-19. Feature 7 of the 8-item backlog deferred by the
2026-08-18 audit; the other seven have shipped.

## Problem

A conversation can be put on a timer: every message sent while the timer is on
is deleted for both participants once its own countdown elapses. The hard part
is not the deletion — it is making sure a message set to disappear never ends
up somewhere the app can no longer delete it from, which in this app means a
participant's own Google Drive.

## Decisions taken up front

- **Per conversation, not per message.** One setting both participants share,
  the WhatsApp/Signal shape, rather than a per-send toggle.
- **The countdown starts at send time**, not at read time. Read-based expiry
  would have to agree with the existing `userALastReadAt`/`userBLastReadAt`
  unread tracking about what "read" means, and it makes a message's lifetime
  unpredictable to the person who sent it. Send-based is one timestamp,
  computed once, and never revisited.
- **Durations: 5 minutes, 1 hour, 24 hours, 7 days, off.** Four options plus
  off; nothing longer, since a very long timer is indistinguishable from no
  timer for a conversation this size.
- **Hard delete the row**, the same as `pruneArchivedMessages` already does —
  not the soft delete `DELETE .../messages/:messageId` uses. A disappearing
  message leaves nothing behind, including the "This message was deleted"
  tombstone. A reply pointing at one degrades exactly as it already does for a
  pruned message: `replyToId` is `ON DELETE SET NULL`, so the reply survives
  with its quote gone.
- **Either participant can change the timer, and changing it is not
  retroactive.** Messages already sent keep the `expiresAt` they were stamped
  with. This is what makes the feature comprehensible: the sender knew the
  message's lifetime at the moment they sent it, and nobody can reach back and
  shorten or extend it afterwards.

## Schema

```prisma
model Conversation {
  /// Seconds, or null for off. Applied at send time to stamp each new
  /// Message.expiresAt; changing it never touches messages already sent.
  disappearingSeconds Int?
}

model Message {
  /// Absolute instant this message is deleted outright, frozen from the
  /// conversation's disappearingSeconds at creation.
  expiresAt DateTime?
}
```

`Message.expiresAt` is indexed (`@@index([expiresAt])`) because the sweep's
only query is `expiresAt <= now()` across the whole table.

Storing an absolute instant rather than a duration is what makes "not
retroactive" fall out for free: there is no later reading of
`disappearingSeconds` that could change an existing message's fate.

## API

- `POST /chat/conversations/:id/disappearing` — body `{ seconds }`, where
  `null` or `0` turns it off. Validated against the allowed set
  (300 / 3600 / 86400 / 604800) rather than accepting arbitrary integers, so
  the UI's options and the server's contract can't drift apart.
- Both participants may set it. Unlike mute (this side only) and like nothing
  else in the app so far, this is genuinely **shared** state, so the change is
  published to both over SSE as `disappearing-changed` with
  `{ conversationId, seconds }`. Mute deliberately publishes nothing because it
  affects only the muter; this affects both, so both are told.
- `GET /chat/conversations` includes `disappearingSeconds` so the thread header
  can show the timer without a second request.

## The sweep

`src/lib/messageExpiry.js#expireMessages()` deletes every `Message` with
`expiresAt <= now()`, and publishes `message-expired` with
`{ conversationId, id }` to both participants of each affected conversation.

Scheduled from `src/server.js` on its own cron (`MESSAGE_EXPIRY_CRON`, default
every minute), alongside the existing Drive sweep. It is **not** gated on
`driveConfigured` the way the Drive sweep is: expiry is a core promise of the
feature, not an optional integration, so it must run in every deployment.

`message-expired` is a distinct event from the existing `message-deleted` on
purpose. `message-deleted` means "a tombstone is now showing"; the frontend
keeps the bubble and swaps its body. `message-expired` means the message is
gone, and the frontend removes it from the list entirely.

## Interaction with the Drive archive

This is the part that needs care, and the rule is simple: **a message with
`expiresAt` set is never archived at all.**

`src/lib/drive.js#archiveUserConversations` gains `expiresAt: null` to its
`newMessages` query. A disappearing message therefore never reaches anyone's
Drive file, so there is no copy to fail to delete later.

The alternative — archive it and delete it from Drive when it expires — was
rejected. It would mean editing a JSONL file in someone else's Drive on a
schedule to remove lines, against a `drive.file` grant the user can revoke at
any moment, with no way to guarantee the delete ever lands. A promise that a
message disappears cannot depend on a third party's API being reachable.

`pruneArchivedMessages` needs a matching change, and missing it would be a
data-loss bug. It deletes `{ conversationId, id: { lte: minWatermark } }`,
which is correct only under the invariant "every id at or below the watermark
has been archived by everyone." Skipping ephemeral messages during archiving
breaks exactly that invariant: an ephemeral message at id 95 sits below a
watermark of 100 without ever having been written to anyone's Drive, so prune
would hard-delete it *before its timer elapsed* — the message would vanish
early and from everywhere.

So prune gains `expiresAt: null` too. The ownership is then clean and total:

- messages with `expiresAt` set are deleted **only** by the expiry sweep,
- messages with `expiresAt` null are deleted **only** by prune.

The watermark itself needs no special handling. It advances to the highest id
the archive query returned, which is now the highest *non-ephemeral* id;
ephemeral messages above it are simply never matched by that query again, and
nothing re-scans in a loop.

One consequence worth stating: because expiring messages are never archived,
`GET .../messages/drive-history` will never return one, and a conversation
whose timer is on simply has less history to scroll back to. That is the
feature working, not a gap.

## Frontend

- A timer control in the thread header next to the existing pin/mute actions,
  offering the four durations and off.
- A small indicator (⏳ plus the duration) on the header while a timer is on,
  matching how mute already shows 🔕.
- `ChatContext` gains `subscribeToDisappearingChanged` and
  `subscribeToMessageExpired`, both on the existing `subscribeViaMap` helper.
- On `message-expired`, `ChatPage` removes the message from state outright —
  no tombstone.
- Translation keys in both locales for the control, the durations, and the
  header indicator.

## Testing

- Setting the timer: accepted values, rejected values, both participants may
  set it, non-participant gets 404.
- A message sent while a timer is on gets `expiresAt`; one sent with the timer
  off gets `null`.
- Changing the timer does not alter `expiresAt` on messages already sent.
- `expireMessages()` deletes only rows past their expiry, leaves unexpired and
  non-expiring rows alone, and publishes `message-expired` for what it deleted.
- A reply to a message that expires survives with `replyToId` nulled.
- `archiveUserConversations` skips messages with `expiresAt` set.
- **`pruneArchivedMessages` does not delete an unexpired ephemeral message
  sitting below the watermark.** This is the regression test for the data-loss
  bug described above and is the single most important test in this feature.

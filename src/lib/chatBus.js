const { EventEmitter } = require("events");

// Intentionally single-process: this is a plain in-memory EventEmitter, not a
// real message broker. It works because this app deploys as exactly one
// container (see render.yaml) — every authenticated user's SSE connection
// terminates on the same Node process that handles the POST that publishes
// to them. Scaling to more than one instance (or a multi-process cluster
// mode) would need every publish to fan out across instances too, e.g. via
// Redis pub/sub — don't assume this file does that, it doesn't.

const emitter = new EventEmitter();
// Many staff/admin users can each have a handful of subscribers (SSE tabs);
// the default limit of 10 listeners per event name would otherwise print
// noisy "MaxListenersExceededWarning" logs well before that's a real leak.
emitter.setMaxListeners(0);

function channelFor(userId) {
  return `user:${userId}`;
}

/** Publish `event` with `payload` to every current subscriber for `userId`. */
function publish(userId, event, payload) {
  emitter.emit(channelFor(userId), event, payload);
}

/**
 * Subscribe to events published for `userId`. `fn` is called as
 * `fn(event, payload)`. Returns an unsubscribe function.
 */
function subscribe(userId, fn) {
  const channel = channelFor(userId);
  emitter.on(channel, fn);
  return () => emitter.off(channel, fn);
}

/**
 * True if `userId` has at least one open SSE stream on this process right
 * now. Used to decide whether a new message needs a push notification —
 * there's no point pushing to someone whose client is already going to
 * receive the same event over the live connection a moment later. Because
 * this only sees subscribers on the current process, it's subject to the
 * same single-instance caveat as the rest of this file: on more than one
 * instance a user connected to a different process would look "not
 * connected" here and get a push they didn't need.
 */
function hasSubscribers(userId) {
  return emitter.listenerCount(channelFor(userId)) > 0;
}

module.exports = { publish, subscribe, hasSubscribers };

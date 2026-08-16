const crypto = require("crypto");

// Single-use, in-memory token store shared by every "can't send a real JWT
// here" spot in this app (the SSE stream ticket, the Google-login ticket,
// the Drive-connect OAuth state) — see CLAUDE.md for why each of those needs
// one. In-process only, same single-instance caveat as chatBus: this doesn't
// survive a restart or fan out across more than one server instance.
function createTicketStore(ttlMs) {
  const store = new Map(); // token -> { payload, expiresAt }

  function issue(payload) {
    const token = crypto.randomBytes(24).toString("hex");
    const expiresAt = Date.now() + ttlMs;
    store.set(token, { payload, expiresAt });
    const timer = setTimeout(() => store.delete(token), ttlMs);
    timer.unref?.();
    return token;
  }

  /** Single-use: returns the associated payload and removes the entry, or null. */
  function consume(token) {
    const entry = store.get(token);
    if (!entry) return null;
    store.delete(token);
    if (entry.expiresAt < Date.now()) return null;
    return entry.payload;
  }

  return { issue, consume };
}

module.exports = { createTicketStore };

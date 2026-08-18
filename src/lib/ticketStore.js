const crypto = require("crypto");

// A single-use, time-limited token kept in process memory: issue() mints a
// random ticket mapped to a value with an expiry, consume() returns that
// value and deletes the ticket (null if it's missing or already expired).
// Three call sites need exactly this shape — the SSE stream ticket
// (src/routes/chat.js), the post-Google-OAuth login ticket
// (src/routes/auth.js), and Drive's connect-state map (src/routes/drive.js)
// — because in each case a value can't safely ride through a URL/query
// string (browser history, Referer, access logs) but the normal
// Authorization-header JWT isn't available at that point either
// (EventSource can't set headers; a top-level OAuth redirect can't carry
// one). Same single-process caveat as chatBus.js: this doesn't survive a
// restart or work across more than one instance.
function createTicketStore(ttlMs) {
  const tickets = new Map();

  function issue(value) {
    const ticket = crypto.randomBytes(24).toString("hex");
    const expiresAt = Date.now() + ttlMs;
    tickets.set(ticket, { value, expiresAt });
    const timer = setTimeout(() => tickets.delete(ticket), ttlMs);
    timer.unref?.();
    return ticket;
  }

  function consume(ticket) {
    const entry = tickets.get(ticket);
    if (!entry) return null;
    tickets.delete(ticket);
    if (entry.expiresAt < Date.now()) return null;
    return entry.value;
  }

  return { issue, consume };
}

module.exports = { createTicketStore };

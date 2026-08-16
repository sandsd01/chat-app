// Cloudflare Turnstile verification for POST /auth/signup — optional in the
// same way Google sign-in/Drive backup/Web Push are: unset TURNSTILE_SECRET_KEY
// and signup simply skips the check rather than the app failing to start or
// every signup 500ing. siteKey is not a secret (it's rendered into the
// signup page itself) but is still served from GET /auth/captcha-config
// rather than baked into the frontend build, matching how the VAPID public
// key is served from GET /push/vapid-public-key instead of a Vite env var —
// one build works across environments without a rebuild per deploy.
const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const siteKey = process.env.TURNSTILE_SITE_KEY || null;
const secretKey = process.env.TURNSTILE_SECRET_KEY || null;
const captchaConfigured = Boolean(secretKey);

/** Only meaningful when captchaConfigured is true — callers check that first. */
async function verifyCaptcha(token, remoteIp) {
  if (!token) return false;

  const body = new URLSearchParams({ secret: secretKey, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);

  try {
    const res = await fetch(VERIFY_URL, { method: "POST", body });
    const data = await res.json();
    return Boolean(data.success);
  } catch (err) {
    console.error("Turnstile verification request failed:", err.message);
    // Fail closed: a broken CAPTCHA check must not silently turn into an
    // open signup form.
    return false;
  }
}

module.exports = { captchaConfigured, siteKey, verifyCaptcha };

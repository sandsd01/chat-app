const { Resend } = require("resend");

function getClient() {
  if (!process.env.RESEND_API_KEY) return null;
  return new Resend(process.env.RESEND_API_KEY);
}

async function sendPasswordResetEmail(user, resetUrl) {
  const client = getClient();
  if (!client) {
    console.warn("RESEND_API_KEY not set; skipping password reset email");
    return { sent: false, reason: "not_configured" };
  }

  await client.emails.send({
    from: process.env.ALERT_EMAIL_FROM || "onboarding@resend.dev",
    to: user.email,
    subject: "Reset your password",
    html:
      "<p>Someone requested a password reset for this account. If this was you, click the link below " +
      "(it expires in 30 minutes):</p>" +
      `<p><a href="${resetUrl}">${resetUrl}</a></p>` +
      "<p>If you didn't request this, you can ignore this email.</p>",
  });

  return { sent: true };
}

module.exports = { sendPasswordResetEmail };

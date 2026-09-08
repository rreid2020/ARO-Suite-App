/**
 * Push branded Clerk email templates from clerk/emails/*.
 * Reads CLERK_SECRET_KEY from the environment or .env.local.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadKey() {
  const env = readFileSync(resolve('.env.local'), 'utf8');
  const line = env.split(/\r?\n/).find((l) => /^CLERK_SECRET_KEY=/.test(l));
  const raw = line ? line.slice('CLERK_SECRET_KEY='.length) : (process.env.CLERK_SECRET_KEY ?? '');
  const key = raw.trim().replace(/^['"]|['"]$/g, '');
  if (!key.startsWith('sk_')) throw new Error('CLERK_SECRET_KEY does not look like a Clerk secret');
  return key;
}

async function putTemplate(slug, payload) {
  const res = await fetch(`https://api.clerk.com/v1/templates/email/${slug}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${loadKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${slug} ${res.status}: ${text.slice(0, 800)}`);
  const json = JSON.parse(text);
  console.log(`updated ${slug}: ${json.subject?.trim()}`);
}

const invitation = {
  name: 'Invitation',
  subject: "You're invited to {{app.name}}",
  markup: readFileSync(resolve('clerk/emails/invitation-markup.html'), 'utf8'),
  body: readFileSync(resolve('clerk/emails/invitation-body.html'), 'utf8'),
  delivered_by_clerk: true,
};

const verification = {
  name: 'Verification code',
  subject: '{{otp_code}} is your {{app.name}} verification code',
  markup: readFileSync(resolve('clerk/emails/verification-markup.html'), 'utf8'),
  body: readFileSync(resolve('clerk/emails/verification-body.html'), 'utf8'),
  delivered_by_clerk: true,
};

await putTemplate('invitation', invitation);
await putTemplate('verification_code', verification);

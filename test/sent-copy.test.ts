import { test } from 'node:test';
import assert from 'node:assert/strict';
import MailComposer from 'nodemailer/lib/mail-composer';
import nodemailer from 'nodemailer';

// The send path composes the message once and hands the SAME bytes to SMTP and to the IMAP append, so
// that the copy filed in Sent is what the recipient actually got. These two facts are what make that
// work, and both fail silently: `raw` is used as is, so nodemailer parses no addresses out of it.
test('a raw message carries no envelope of its own', async () => {
  const composed = new MailComposer({ from: 'me@example.com', to: 'you@example.org', subject: 'x', text: 'y' }).compile();
  const raw = await composed.build();
  const info = await nodemailer.createTransport({ jsonTransport: true }).sendMail({ raw });
  // Not a quirk to work around but the reason the envelope is passed explicitly: without it a send
  // reports success and reaches nobody.
  assert.deepEqual(info.envelope, { from: false, to: [] });
});

test('the composed envelope and Message-ID describe the bytes that were built', async () => {
  const composed = new MailComposer({
    from: 'me@example.com', to: ['you@example.org', 'other@example.net'], subject: 'x', text: 'y',
  }).compile();
  const raw = await composed.build();
  const envelope = composed.getEnvelope();
  const info = await nodemailer.createTransport({ jsonTransport: true })
    .sendMail({ raw, envelope: { ...envelope, from: envelope.from || 'me@example.com' } });

  assert.deepEqual(info.envelope, { from: 'me@example.com', to: ['you@example.org', 'other@example.net'] });
  // The id reported to the caller is read off the composed message, never from the transport's reply:
  // the transport mints one of its own for a raw message, which would name something that was never sent.
  assert.ok(raw.toString().includes(`Message-ID: ${composed.messageId()}`));
  assert.notEqual(info.messageId, composed.messageId());
});

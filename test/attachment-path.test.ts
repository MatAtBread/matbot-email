import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messagePrefix, attachmentPath, parseAttachmentPath } from '../src/attachments.ts';

// The whole cleanup mechanism is a prefix match over these names, so a change to the shape that is not
// matched in parseAttachmentPath silently stops reclaiming anything.
test('a stored path is addressed by its message prefix', () => {
  const name = attachmentPath('abc123', 'INBOX', 42n, 7, '1.2', 'report.pdf');
  assert.equal(name, 'abc123/INBOX/42/7/1.2/report.pdf');
  assert.ok(name.startsWith(messagePrefix('abc123', 'INBOX', 42n, 7)));
});

test('a path round-trips back to its address', () => {
  const name = attachmentPath('abc123', '[Gmail]/Sent Mail', 1234567n, 9001, '2', 'a b.png');
  assert.deepEqual(parseAttachmentPath(name), {
    acctId: 'abc123', folder: '_Gmail__Sent_Mail', uidValidity: '1234567', uid: 9001,
  });
});

test('a filename with slashes cannot forge extra segments', () => {
  const name = attachmentPath('abc123', 'INBOX', 1n, 2, '1', '../../evil/x.sh');
  assert.equal(name, 'abc123/INBOX/1/2/1/.._.._evil_x.sh');
  assert.deepEqual(parseAttachmentPath(name)!.uid, 2);
});

test('anything that is not a message address is left alone', () => {
  assert.equal(parseAttachmentPath('abc123/INBOX/42/7/1.2'), null);   // too few segments
  assert.equal(parseAttachmentPath('abc123/INBOX/42/nope/1/x.pdf'), null);
});

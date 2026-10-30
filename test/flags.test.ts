import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { isSeen, parseUids } from '../src/flags.ts';

// Through imapflow's own parser rather than a hand-built message: the bug was assuming the shape it hands
// back (an array, where it is a Set), and a fixture written to the same assumption would have passed.
const require = createRequire(import.meta.url);
const { parser } = require('imapflow/lib/handler/imap-handler.js') as { parser: (line: Buffer) => Promise<unknown> };
const tools = require('imapflow/lib/tools.js') as {
  formatMessageResponse: (untagged: unknown, mailbox: object) => Promise<{ uid?: number; flags?: Set<string> }>;
};

async function fetched(line: string) {
  return tools.formatMessageResponse(await parser(Buffer.from(line)), {});
}

test('a message the server reports \\Seen reads as seen', async () => {
  assert.equal(isSeen((await fetched('* 1 FETCH (UID 7 FLAGS (\\Seen))')).flags), true);
  assert.equal(isSeen((await fetched('* 2 FETCH (UID 8 FLAGS (\\Answered \\Seen $Forwarded))')).flags), true);
});

test('a message without \\Seen reads as unseen', async () => {
  assert.equal(isSeen((await fetched('* 3 FETCH (UID 9 FLAGS ())')).flags), false);
  assert.equal(isSeen((await fetched('* 4 FETCH (UID 10 FLAGS (\\Flagged))')).flags), false);
  // No FLAGS item at all — a fetch that did not ask for them — is unknown, and reported as unseen.
  assert.equal(isSeen((await fetched('* 5 FETCH (UID 11)')).flags), false);
});

test('ids are UIDs, one or many, without repeats', () => {
  assert.deepEqual(parseUids('42'), [42]);
  assert.deepEqual(parseUids(['3', '1', '3']), [3, 1]);
});

// Each of these is a valid IMAP sequence set, or close to one, and `1:*` is the whole folder.
test('anything that is not a single UID is refused', () => {
  for (const bad of ['1:*', '*', '1,2', '1:5', '', '0', '-1', ' 7', '7 ', '1e3']) {
    const res = parseUids(bad);
    assert.ok(!Array.isArray(res), `accepted ${JSON.stringify(bad)}`);
  }
  assert.ok(!Array.isArray(parseUids([])));
  assert.ok(!Array.isArray(parseUids(['5', '6:*'])), 'one bad id refuses the whole mark');
});

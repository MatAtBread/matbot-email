// imapflow reports a message's flags as a Set. It was read as an array, which is false for a Set, so every
// message in every folder came back unread — including the copies filed in Sent, which are stored \Seen.
export function isSeen(flags: Set<string> | undefined): boolean {
  return flags?.has('\\Seen') ?? false;
}

// The ids handed to a STORE become an IMAP sequence set, where `1:*` is every message in the folder. Only
// bare UIDs are accepted, so a mark addresses exactly the messages named and a malformed id cannot widen it.
export function parseUids(ids: string | string[]): number[] | { error: string } {
  const list = Array.isArray(ids) ? ids : [ids];
  if (list.length === 0) return { error: 'No message id given.' };
  const bad = list.filter(id => !/^[1-9]\d*$/.test(id));
  if (bad.length) return { error: `Not a message id: ${bad.map(b => JSON.stringify(b)).join(', ')}. Use the 'id' values 'list' returned.` };
  return [...new Set(list.map(Number))];
}

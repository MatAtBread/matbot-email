import type { FileHandle, ToolContext } from '@matatbread/matbot-plugin-api';

// Attachments are materialised HERE, never into the user's workspace.
export const ATTACH_NS = 'email_attachments';

const DEFAULT_FOLDER = 'INBOX';

export function safeSegment(s: string, fallback: string): string {
  return (s || fallback).replace(/[^a-zA-Z0-9._-]/g, '_');
}

// The prefix naming every part of ONE message. Cleanup is a prefix match rather than a stored index
// because the path already IS the index: the address was built to be reversible, so nothing has to be
// kept in step with it.
export function messagePrefix(acctId: string, folder: string, uidValidity: bigint | string, uid: number | string): string {
  return `${acctId}/${safeSegment(folder, DEFAULT_FOLDER)}/${uidValidity}/${uid}/`;
}

export function attachmentPath(acctId: string, folder: string, uidValidity: bigint, uid: number, part: string, filename: string): string {
  return `${messagePrefix(acctId, folder, uidValidity, uid)}${part}/${safeSegment(filename, 'attachment')}`;
}

// The address read back out. `folder` is the MANGLED segment, not the mailbox path — safeSegment is not
// invertible ("[Gmail]/Sent Mail" and "_Gmail__Sent_Mail" are the same segment), so a caller that needs
// the real mailbox matches it against the server's own folder list rather than trying to decode it.
export function parseAttachmentPath(name: string): { acctId: string; folder: string; uidValidity: string; uid: number } | null {
  const seg = name.split('/');
  if (seg.length < 6) return null;
  const [acctId, folder, uidValidity, uid] = seg as [string, string, string, string];
  const n = Number(uid);
  if (!acctId || !folder || !uidValidity || !Number.isInteger(n)) return null;
  return { acctId, folder, uidValidity, uid: n };
}

// Every attachment materialised under this namespace, newest-first order irrelevant. There is no
// name-prefix filter on FileFilter, so the namespace is listed and matched here — the namespace is this
// plugin's alone, so the listing is bounded by what this plugin itself stored.
export async function* storedAttachments(files: NonNullable<ToolContext['files']>): AsyncIterable<FileHandle> {
  for await (const handle of files.list({ namespace: ATTACH_NS })) yield handle;
}

// Drop every file belonging to one message. Best-effort by contract: the caller has already destroyed
// the message on the server, and reporting a failure afterwards would misdescribe what happened.
export async function sweepMessageAttachments(
  files: NonNullable<ToolContext['files']> | undefined,
  acctId: string, folder: string, uidValidity: bigint, uid: number,
): Promise<number> {
  if (!files) return 0;
  const prefix = messagePrefix(acctId, folder, uidValidity, uid);
  let removed = 0;
  try {
    const doomed: string[] = [];
    for await (const handle of storedAttachments(files)) {
      if (handle.name.startsWith(prefix)) doomed.push(handle.id);
    }
    for (const id of doomed) { await files.delete(id); removed++; }
  } catch { return removed; }
  return removed;
}

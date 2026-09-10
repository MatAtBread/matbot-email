import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type {
  MatbotPluginSpec, MatbotMachine, Tool, ToolEvent, ToolContract, ToolResultOf, ToolContext, Store,
  FileHandle, MimeType,
} from '@matatbread/matbot-plugin-api';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { createHash } from 'node:crypto';
import { collectStructure, type AttachmentInfo } from './structure.js';
import {
  ATTACH_NS, safeSegment, attachmentPath, parseAttachmentPath, storedAttachments, sweepMessageAttachments,
} from './attachments.js';

// ── Tool contracts ─────────────────────────────────────────────────────────────
// The result + params pairing for each arm. `configure` and `set-password` are the only actions that
// touch the vault; everything else resolves credentials from it at connect time.

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    email_action:
      | ToolContract<{ ok: true; account: string }, { action: 'configure'; account: string; address: string; imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; useTLS?: boolean; smtpTLS?: boolean; password?: string }>
      | ToolContract<{ ok: true; account: string }, { action: 'set-password'; account: string; password: string }>
      | ToolContract<{ removed: boolean }, { action: 'remove-account'; account: string }>
      | ToolContract<{ accounts: Account[] }, { action: 'accounts' }>
      | ToolContract<{ contacts: Contact[] }, { action: 'contacts' }>
      | ToolContract<{ added: Contact }, { action: 'add-contact'; name: string; address: string }>
      | ToolContract<{ removed: boolean }, { action: 'remove-contact'; name: string }>
      | ToolContract<{ folders: FolderInfo[] }, { action: 'folders'; account?: string }>
      | ToolContract<{ messages: MessageSummary[] }, { action: 'list'; account?: string; folder?: string; since?: string; limit?: number }>
      | ToolContract<{ message: MessageDetail; attachments: AttachmentInfo[] }, { action: 'read'; account?: string; folder?: string; id: string; markSeen?: boolean }>
      | ToolContract<{ deleted: boolean; attachmentsRemoved: number }, { action: 'delete'; account?: string; folder?: string; id: string }>
      | ToolContract<{ attachments: AttachmentInfo[] }, { action: 'list_attachments'; account?: string; folder?: string; id: string }>
      | ToolContract<{ url: string; name: string; bytes: number }, { action: 'attachment_url'; account?: string; folder?: string; id: string; part: string }>
      | ToolContract<{ name: string; mimeType: string; bytes: number }, { action: 'attachment_show'; account?: string; folder?: string; id: string; part: string }>
      | ToolContract<PurgeReport, { action: 'purge_attachments'; account?: string }>
      | ToolContract<{ ok: true; messageId?: string }, { action: 'send'; account?: string; to: string | string[]; subject: string; body: string; replyTo?: string; attach?: string[] }>
      | ToolContract<{ ok: true }, { action: 'reply'; account?: string; folder?: string; id: string; body: string; attach?: string[] }>;
  }
}

// ── Store shapes (id + version satisfy Store<T>) ───────────────────────────────

interface Account {
  id: string; version: string;
  address: string; imapHost: string; imapPort: number;
  smtpHost: string; smtpPort: number; createdAt: string;
  // TWO facts, not one. `useTLS` is IMAP's implicit TLS; `smtpTLS` is SMTP's, which is a different
  // question with a different answer on the commonest setup there is: 465 is implicit TLS, while 587 is
  // plaintext-then-STARTTLS and needs `secure: false`. One flag for both made 587 unconfigurable except
  // by also turning IMAP TLS off. When smtpTLS is false the transport sets `requireTLS`, so the upgrade
  // is mandatory rather than opportunistic — "not implicit TLS" must never mean "in the clear".
  useTLS: boolean;
  smtpTLS: boolean;
  // The human label ("mat", "matbot") used to address this account in tool calls ("check mat's email").
  // Queryable via the store's filter grammar; distinct from `id`, which is a stable hash of the mailbox
  // identity so reconfiguring the same mailbox reuses the same id (and the same derived vault key).
  tag: string;
}

interface Contact {
  id: string; version: string;
  name: string; address: string; createdAt: string;
}

interface MessageSummary { id: string; subject: string; from: string; date: string | null; seen: boolean }
// `text` only, deliberately: a tool result is persisted in the transcript and re-sent on every later
// round, so a second copy of the body is paid for the life of the session. The name says what it is —
// mailparser's text, which is HTML-to-text converted when the message carries no plain part.
interface MessageDetail extends MessageSummary { to: string; text: string; replyTo?: string }

// One mailbox as the server reports it. `path` is the string every other action takes as `folder`;
// `specialUse` is why this action exists at all — a server names its Sent folder "Sent", "INBOX.Sent" or
// "[Gmail]/Sent Mail" as it pleases, and the \\Sent flag is the only portable way to ask for it.
// `specialUseSource` is reported because "extension" is the server's own word and "name" is imapflow
// matching against known localised names, which is a guess worth being able to distrust.
interface FolderInfo {
  path: string;
  name: string;
  delimiter: string;
  specialUse?: string;
  specialUseSource?: string;
  subscribed: boolean;
  unseen?: number;
}

// ── The discriminated union the executor switches on ──────────────────────────

type EmailAction =
  | { action: 'configure'; account: string; address: string; imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; useTLS?: boolean; smtpTLS?: boolean; password?: string }
  | { action: 'set-password'; account: string; password: string }
  | { action: 'remove-account'; account: string }
  | { action: 'accounts' }
  | { action: 'contacts' }
  | { action: 'add-contact'; name: string; address: string }
  | { action: 'remove-contact'; name: string }
  | { action: 'folders'; account?: string }
  | { action: 'list'; account?: string; folder?: string; since?: string; limit?: number }
  | { action: 'read'; account?: string; folder?: string; id: string; markSeen?: boolean }
  | { action: 'delete'; account?: string; folder?: string; id: string }
  | { action: 'list_attachments'; account?: string; folder?: string; id: string }
  | { action: 'attachment_url'; account?: string; folder?: string; id: string; part: string }
  | { action: 'attachment_show'; account?: string; folder?: string; id: string; part: string }
  | { action: 'purge_attachments'; account?: string }
  | { action: 'send'; account?: string; to: string | string[]; subject: string; body: string; replyTo?: string; attach?: string[] }
  | { action: 'reply'; account?: string; folder?: string; id: string; body: string; attach?: string[] };

const ACCOUNTS_NS  = 'email_accounts';
const CONTACTS_NS  = 'email_contacts';
const WORKSPACE_NS = 'workspace';

const DEFAULT_FOLDER = 'INBOX';

let accountsStore: Store<Account> | undefined;
let contactsStore: Store<Contact> | undefined;
// The MACHINE, not `services.FilePartition`. FilePartition is optional and may be registered by a plugin
// loading after this one, so a value captured in setup() is `undefined` for the life of the process and
// every attachment URL silently loses its `~<partition>` prefix — addressing the wrong area, with a
// well-formed URL to show for it. Reading the member per call follows a registration, and the swap
// proxies mean a captured machine keeps resolving to the current impl.
let machine: MatbotMachine | undefined;

function now(): string { return new Date().toISOString(); }

function folderOf(act: { folder?: string }): string { return act.folder ?? DEFAULT_FOLDER; }

// Derived purely from the account id (a stable hash of the mailbox identity), never stored and never
// looked up: that is what makes the key unique per account with no extra read. The vault resolves
// ${NAME} placeholders rather than bare keys, so the reference is the wrapped placeholder.
function accountVaultKey(acct: Account): string {
  return '${email_' + acct.id + '_password}';
}

function showArm(mimeType: string): 'image' | 'audio' | 'document' | null {
  const base = mimeType.split(';')[0]!.trim().toLowerCase();
  if (base === 'image/svg+xml') return null;
  if (base.startsWith('image/')) return 'image';
  if (base.startsWith('audio/')) return 'audio';
  if (base === 'application/pdf') return 'document';
  if (base.startsWith('text/'))    return null;   // text is better read than shown
  return null;
}

// A MIME part is addressed as <account-id>/<folder>/<uidvalidity>/<uid>/<part>/<filename>, so a given
// attachment is stored once and re-served by name.
//
// All three of folder, UIDVALIDITY and UID are needed to name a message. A UID is unique only within one
// mailbox, and only for as long as the mailbox keeps its UIDVALIDITY — which is precisely the value the
// server bumps to say "forget every UID you hold, they mean something else now". Without it a rebuilt
// mailbox re-serves a stale file under a UID that names a different message: a cache hit on the wrong
// message, which is worse than a miss because nothing looks wrong.
interface PurgeReport { removed: number; bytes: number; kept: number; unchecked: number }

// Reconcile everything stored for one account against the server. This is the mechanism that matters:
// sweeping our own `delete` only reclaims what matbot itself destroyed, and the ordinary case is a
// message deleted from webmail or a phone, which this plugin never hears about.
//
// A stale UIDVALIDITY generation is an orphan with no round trip at all — the server bumping it is a
// statement that every UID under the old value now means something else — so the cheap half of the
// answer costs nothing.
//
// Conservative on every uncertainty: a folder that will not open is REPORTED, never emptied. Failing to
// check is not evidence of absence, and the wrong answer here deletes a file that is still reachable.
async function purgeAccountAttachments(ctx: ToolContext, acct: Account, files: NonNullable<ToolContext['files']>): Promise<PurgeReport> {
  // Grouped by the MANGLED folder segment, which is all the stored name carries.
  const byFolder = new Map<string, { handle: FileHandle; addr: string }[]>();
  for await (const handle of storedAttachments(files)) {
    const parsed = parseAttachmentPath(handle.name);
    if (!parsed || parsed.acctId !== acct.id) continue;
    const group = byFolder.get(parsed.folder) ?? [];
    group.push({ handle, addr: `${parsed.uidValidity}/${parsed.uid}` });
    byFolder.set(parsed.folder, group);
  }
  const report: PurgeReport = { removed: 0, bytes: 0, kept: 0, unchecked: 0 };
  if (byFolder.size === 0) return report;

  const doomed: FileHandle[] = [];
  const client = await connectImap(ctx, acct);
  try {
    const boxes = await client.list();
    for (const [segment, group] of byFolder) {
      // safeSegment is not invertible, so the real mailbox is recovered by mangling the server's own
      // folder list and matching. More than one match is possible in principle; a UID live in ANY of
      // them keeps the file, because the alternative deletes something still addressable.
      const candidates = boxes.filter(b => safeSegment(b.path, DEFAULT_FOLDER) === segment);
      if (candidates.length === 0) { doomed.push(...group.map(g => g.handle)); continue; }
      const live = new Set<string>();
      let checked = false;
      for (const box of candidates) {
        try {
          const mailbox = await client.mailboxOpen(box.path, { readOnly: true });
          const uids = await client.search({ all: true }, { uid: true });
          for (const uid of uids || []) live.add(`${mailbox.uidValidity}/${uid}`);
          checked = true;
        } catch { /* \Noselect, gone, or refused — leave `checked` false for this candidate */ }
      }
      if (!checked) { report.unchecked += group.length; continue; }
      for (const { handle, addr } of group) {
        if (live.has(addr)) report.kept++; else doomed.push(handle);
      }
    }
  } finally {
    await client.logout();
  }

  for (const handle of doomed) {
    await files.delete(handle.id);
    report.removed++;
    report.bytes += handle.size;
  }
  return report;
}

// Derive a servable /files/ URL for a stored handle, exactly as url_for_resource does — reproduced rather
// than called because a tool cannot invoke another tool.
//
// KNOWN COUPLING: `/files/` is the *web* frontend's route. The dom frontend answers the same question
// with a `blob:` URL, so a link handed out here means nothing there. There is no better option available
// to a tool — returning the bare file name would push the resolution onto every frontend — so this is a
// stated limitation, not a claim of neutrality.
//
// `undefined` when the handle carries no namespace: there is no addressable path under this route, which
// is what url_for_resource reports as "not viewable". An empty segment would yield `/files//name` — a
// well-formed URL for nothing, which is worse than saying no.
function fileUrl(handle: FileHandle): string | undefined {
  if (handle.namespace === undefined) return undefined;
  const partition = machine?.FilePartition?.current();
  const prefix = partition ? `~${encodeURIComponent(partition)}/` : '';
  const path = `${encodeURIComponent(handle.namespace)}/${handle.name.split('/').map(encodeURIComponent).join('/')}`;
  return `/files/${prefix}${path}`;
}

// Read workspace files (via ctx.files) into nodemailer attachment objects.
async function buildAttachments(ctx: ToolContext, names: string[] | undefined): Promise<import('nodemailer').Attachment[]> {
  if (!names || names.length === 0) return [];
  if (!ctx.files) throw new Error('No file store available to read attachments from.');
  const out: import('nodemailer').Attachment[] = [];
  for (const name of names) {
    const handle = await ctx.files.getByName(name, WORKSPACE_NS);
    if (!handle) throw new Error(`No workspace file named "${name}".`);
    const chunks: Uint8Array[] = [];
    for await (const b of handle.stream()) chunks.push(b);
    const buf = Buffer.concat(chunks.map(c => Buffer.from(c)));
    out.push({ filename: handle.name, content: buf, contentType: handle.mimeType });
  }
  return out;
}

// Stable, unique account id: a hash over the mailbox's own identity (the things that truly distinguish a
// mailbox and never change with its display tag). Deterministic, so reconfiguring the same mailbox
// reuses the same id and the same derived vault key; distinct addresses never collide.
function accountId(address: string, imapHost: string, imapPort: number): string {
  return createHash('sha256').update(`${address}\u0000${imapHost}\u0000${imapPort}`).digest('hex');
}

// ── Credentials ────────────────────────────────────────────────────────────────
// imapflow defaults to a pino logger at level 'trace', which floods the process with protocol debug/trace
// dumps on every connection and fetch. We silence that (a logger that swallows everything except real
// error conditions) so the plugin is quiet unless something actually goes wrong.
const quietLogger = {
  trace() {}, debug() {}, info() {}, warn() {},
  error(obj: unknown) { console.error('[email] imap error:', obj); },
  fatal(obj: unknown) { console.error('[email] imap fatal:', obj); },
};

// One transport builder for both send and reply — they had identical inline copies, and the STARTTLS
// rule below is exactly the kind of thing that gets fixed in one of two copies.
async function smtpTransport(ctx: ToolContext, acct: Account) {
  const pass = await ctx.vault.resolve(accountVaultKey(acct));
  return nodemailer.createTransport({
    host: acct.smtpHost, port: acct.smtpPort, secure: acct.smtpTLS,
    // Opportunistic STARTTLS silently sends in the clear against a server that does not offer it, which
    // is not what "my submission port is 587" asks for. Demand the upgrade instead, and fail loudly.
    ...(acct.smtpTLS ? {} : { requireTLS: true }),
    auth: { user: acct.address, pass },
  });
}

async function connectImap(ctx: ToolContext, acct: Account): Promise<ImapFlow> {
  const pass = await ctx.vault.resolve(accountVaultKey(acct));
  const client = new ImapFlow({
    host: acct.imapHost,
    port: acct.imapPort,
    secure: acct.useTLS,
    auth: { user: acct.address, pass },
    logger: quietLogger,
  });
  await client.connect();
  return client;
}

async function resolveAccount(ctx: ToolContext, ref?: string): Promise<Account> {
  if (!accountsStore) throw new Error('email accounts store is not ready');
  let acct: Account | null = null;
  if (ref) {
    // Resolve by tag, id, or address — the caller may say "mat", a raw id, or a full address. When a
    // tag/address matches both a current-scheme account AND a pre-refactor orphan (one with no tag),
    // prefer the current-scheme account so the password lands under the id it actually resolves to.
    let res = await accountsStore.query({ where: { op: 'or', clauses: [
      { op: 'eq', field: 'tag', value: ref },
      { op: 'eq', field: 'id', value: ref },
    ] }, limit: 1 });
    acct = res.items[0] ?? null;
    if (!acct) {
      res = await accountsStore.query({ where: { op: 'eq', field: 'address', value: ref }, limit: 1 });
      acct = res.items[0] ?? null;
    }
  } else {
    // Prefer a current-scheme account (one with a `tag`) over a legacy record when inferring the default,
    // so a pre-refactor orphan does not shadow the actively-configured account.
    const res = await accountsStore.query({ where: { op: 'exists', field: 'tag', value: true }, limit: 1 });
    acct = res.items[0] ?? null;
    if (!acct) { const any = await accountsStore.query({ limit: 1 }); acct = any.items[0] ?? null; }
  }
  if (!acct) throw new Error(`No email account${ref ? ` matching "${ref}"` : ''} configured. Run email_action configure first.`);
  return acct;
}

async function contactAddress(ctx: ToolContext, name: string): Promise<string> {
  if (name.includes('@')) return name;
  if (!contactsStore) throw new Error('email contacts store is not ready');
  const found = await contactsStore.get(name);
  if (!found) throw new Error(`Unknown contact "${name}". Add a contact with add-contact, or use an email address.`);
  return found.address;
}

// Fetch + parse a message (BODY.PEEK, so no \Seen side effect unless markSeen), returning detail + attachments.
async function fetchMessage(ctx: ToolContext, acct: Account, folder: string, id: string, markSeen: boolean):
  Promise<{ detail: MessageDetail; attachments: AttachmentInfo[]; uidValidity: bigint } | null> {
  const client = await connectImap(ctx, acct);
  try {
    const mailbox = await client.mailboxOpen(folder);
    const found = await client.fetchOne(String(id), { source: true, envelope: true, flags: true, bodyStructure: true }, { uid: true });
    if (!found) return null;
    const parsed = await simpleParser(found.source as Buffer);
    const from = found.envelope?.from?.[0];
    const to = found.envelope?.to?.[0];
    const detail: MessageDetail = {
      id: String(found.uid),
      subject: parsed.subject ?? '(no subject)',
      from: from ? `${from.name ? from.name + ' ' : ''}<${from.address}>` : '(unknown sender)',
      to: to ? (to.address ?? '') : '',
      date: found.envelope?.date ? new Date(found.envelope.date).toISOString() : null,
      seen: Array.isArray(found.flags) && found.flags.includes('\\Seen'),
      text: parsed.text ?? '',
      ...(parsed.replyTo?.value?.[0]?.address ? { replyTo: parsed.replyTo.value[0].address } : {}),
    };
    if (markSeen) await client.messageFlagsAdd(String(id), ['\\Seen'], { uid: true });
    return { detail, attachments: collectStructure(found.bodyStructure), uidValidity: mailbox.uidValidity };
  } finally {
    await client.logout();
  }
}

// Attachment metadata with NO body: one BODYSTRUCTURE fetch, and the connection closed again. This is
// what `list_attachments` costs now — the whole message used to come down the wire for it.
async function fetchStructure(ctx: ToolContext, acct: Account, folder: string, id: string):
  Promise<{ attachments: AttachmentInfo[]; uidValidity: bigint } | null> {
  const client = await connectImap(ctx, acct);
  try {
    const mailbox = await client.mailboxOpen(folder);
    const found = await client.fetchOne(String(id), { bodyStructure: true }, { uid: true });
    if (!found) return null;
    return { attachments: collectStructure(found.bodyStructure), uidValidity: mailbox.uidValidity };
  } finally {
    await client.logout();
  }
}

// Anything larger is not shown. `attachment_show` inlines the bytes into the turn as base64 — 4/3 of the
// file — where they stay for the rest of it, so an unbounded one is a context blown on a single call.
// Checked against BODYSTRUCTURE's declared size BEFORE downloading, rather than truncating mid-stream:
// half a PDF is not a smaller answer, it is a corrupt one.
const SHOW_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Open the message's structure and hand back the client with the mailbox still selected, so the caller
 * can `download` a part on the same connection. The caller owns the logout — a stream is only readable
 * while its connection lives, which is the whole reason this does not close it.
 */
async function openForPart(ctx: ToolContext, acct: Account, folder: string, id: string, part: string):
  Promise<{ client: ImapFlow; info: AttachmentInfo; uidValidity: bigint } | { client: ImapFlow; error: string }> {
  const client = await connectImap(ctx, acct);
  const mailbox = await client.mailboxOpen(folder);
  const found = await client.fetchOne(String(id), { bodyStructure: true }, { uid: true });
  if (!found) return { client, error: `No message ${id} in ${folder}.` };
  const info = collectStructure(found.bodyStructure).find(a => a.part === part);
  if (!info) return { client, error: `No attachment part "${part}" on message ${id}.` };
  return { client, info, uidValidity: mailbox.uidValidity };
}

// ── The executor ───────────────────────────────────────────────────────────────

const emailTool: Tool<ToolResultOf<'email_action'>> = {
  name: 'email_action',
  description: `Manage email on a generic IMAP/SMTP server.

  type EmailAction =
    | { action: 'configure';        account: string; address: string; imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; useTLS?: boolean; smtpTLS?: boolean; password?: string }
    | { action: 'set-password';     account: string; password: string }
    | { action: 'remove-account';   account: string }
    | { action: 'accounts' }
    | { action: 'contacts' }
    | { action: 'add-contact';          name: string; address: string }
    | { action: 'remove-contact';       name: string }
    | { action: 'folders';          account?: string }
    | { action: 'list';             account?: string; folder?: string; since?: string; limit?: number }
    | { action: 'read';             account?: string; folder?: string; id: string; markSeen?: boolean }
    | { action: 'delete';           account?: string; folder?: string; id: string }
    | { action: 'list_attachments'; account?: string; folder?: string; id: string }
    | { action: 'attachment_url';   account?: string; folder?: string; id: string; part: string }
    | { action: 'attachment_show';  account?: string; folder?: string; id: string; part: string }
    | { action: 'purge_attachments'; account?: string }
    | { action: 'send';             account?: string; to: string | string[]; subject: string; body: string; replyTo?: string; attach?: string[] }
    | { action: 'reply';            account?: string; folder?: string; id: string; body: string; attach?: string[] };

  Configure an account once, then list/read/delete/send/reply. Credentials are stored in the vault the first
  time you \\\`configure\\\` (or via \\\`set-password\\\`) — never in conversation text. Contacts map a name to
  an address so you can say "email Fred" instead of a full address. send/reply change the mailbox, so
  confirm with the user before firing one. 'delete' permanently removes a message (flag + expunge) and
  is irreversible — confirm before firing it too. Default account is the single configured one.

  Folders: every action that addresses a mailbox takes an optional 'folder', defaulting to INBOX. A message
  'id' is a UID, which is unique only WITHIN one folder — so pass the same folder to read/delete/attachment_*
  that you passed to the 'list' the id came from.

  Do not GUESS a folder name: call 'folders' and use a returned 'path'. Servers name the same folder "Sent",
  "INBOX.Sent" or "[Gmail]/Sent Mail", so match on 'specialUse' (\\Sent, \\Drafts, \\Trash, \\Junk,
  \\Archive) rather than on the name. 'unseen' is the unread count, so "any unread mail?" is one call.

  'list' with 'since' (an ISO date) searches the server for mail on or after that date rather than filtering
  the newest few, which is the difference that matters after a quiet week. IMAP compares dates only, so the
  time of day in a timestamp is ignored.

  Attachments: 'read' ALREADY returns the attachment list, so do not call list_attachments after a read —
  it answers the same question. list_attachments is for when you have an id but have not read the message.
  Both return metadata only (part, filename, type, size, disposition, cid) and NO bytes.

  To see one yourself, use attachment_show — it puts the image/audio/document in front of your eyes so you
  can reason about it, and the bytes are never persisted. To hand the USER something they can open, use
  attachment_url — it saves the file and returns a link. Pass the 'part' exactly as reported; it is the
  IMAP part number ("2", "1.2"). Nothing here marks the message read.

  Only the part you ask for is fetched, so showing one attachment does not download the others. A part too
  large to put in context is refused with its size — use attachment_url for that one.

  attachment_url is the only action that keeps anything. 'delete' cleans up after itself, but a message
  deleted elsewhere — webmail, a phone — leaves its saved attachments behind, because nothing tells this
  plugin it went. purge_attachments reconciles the saved files against the server and deletes the
  orphans; it never touches a file whose message is still there. Run it when asked to tidy up, or if the
  user asks what the saved attachments are costing — not routinely, and not after a delete.`,
  inputSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action:    { type: 'string', enum: ['configure', 'set-password', 'remove-account', 'accounts', 'contacts', 'add-contact', 'remove-contact', 'folders', 'list', 'read', 'delete', 'list_attachments', 'attachment_url', 'attachment_show', 'purge_attachments', 'send', 'reply'] },
      account:   { type: 'string' },
      address:   { type: 'string' },
      imapHost:  { type: 'string' },
      imapPort:  { type: 'number' },
      smtpHost:  { type: 'string' },
      smtpPort:  { type: 'number' },
      useTLS:    { type: 'boolean', description: 'IMAP implicit TLS (default true).' },
      smtpTLS:   { type: 'boolean', description: 'SMTP implicit TLS. Defaults from smtpPort: true for 465, false (STARTTLS) otherwise.' },
      password:  { type: 'string' },
      folder:    { type: 'string', description: 'Mailbox to act on. Defaults to INBOX.' },
      id:        { type: 'string' },
      part:      { type: 'string' },
      since:     { type: 'string' },
      limit:     { type: 'number' },
      to:        { type: ['string', 'array'], items: { type: 'string' } },
      subject:   { type: 'string' },
      body:      { type: 'string' },
      replyTo:   { type: 'string' },
      attach:    { type: 'array', items: { type: 'string' }, description: 'Workspace file name(s) to attach.' },
      name:      { type: 'string' },
      markSeen:  { type: 'boolean' },
    },
  },
  executor: {
    async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent<ToolResultOf<'email_action'>>> {
      const act = input as EmailAction;

      switch (act.action) {
        case 'configure': {
          if (!accountsStore) throw new Error('email accounts store is not ready');
          // The account id is a stable hash of the mailbox identity, so reconfiguring the same mailbox
          // reuses the same id — and the same derived vault key — regardless of its display tag.
          const id = accountId(act.address, act.imapHost, act.imapPort);
          const existing = await accountsStore.get(id);
          const acct: Account = {
            // A NEW version every write. Reusing the one just read would leave the stored version
            // constant, and a compare-and-swap against a value that never changes cannot detect anything.
            id, version: crypto.randomUUID(),
            address: act.address, imapHost: act.imapHost, imapPort: act.imapPort,
            smtpHost: act.smtpHost, smtpPort: act.smtpPort, useTLS: act.useTLS ?? true,
            // Defaulted from the PORT, which is the thing that actually decides it: 465 is implicit TLS,
            // 587 and 25 are STARTTLS. An explicit smtpTLS overrides, for a server that disagrees.
            smtpTLS: act.smtpTLS ?? act.smtpPort === 465,
            createdAt: existing?.createdAt ?? now(),
            tag: act.account,
          };
          // The password's vault key is derived purely from the id — never stored, never looked up.
          //
          // Written BEFORE the account, and deliberately: the key comes from the id, which is a hash of
          // the mailbox identity, so the secret is right for this mailbox whatever happens to the record.
          // A secret stored for a write that then loses a CAS is inert; an account stored without its
          // secret cannot authenticate.
          if (act.password) await ctx.vault.createSecret(`email_${id}_password`, act.password);

          // `cas` requires a document to compare against — it reports ok:false for one that does not
          // exist — so a create is a `set`, which has no earlier version to contradict, and only an
          // update is a compare-and-swap.
          if (existing === null) {
            await accountsStore.set(acct.id, acct);
          } else {
            const res = await accountsStore.cas(acct.id, existing.version, acct);
            if (!res.ok) {
              yield { type: 'error', message:
                `Account "${act.account}" was changed by something else while this was being written — ` +
                `nothing was saved. Read it back with 'accounts' and configure again.` };
              return;
            }
          }
          yield { type: 'result', value: { ok: true, account: acct.address } };
          return;
        }

        case 'set-password': {
          if (!accountsStore) throw new Error('email accounts store is not ready');
          const acct = await resolveAccount(ctx, act.account);
          await ctx.vault.createSecret(`email_${acct.id}_password`, act.password);
          // The address, not the reference passed in: `account` is resolved from a tag, an id OR an
          // address, so echoing the input would make one result field mean three different things, and
          // `configure` already answers with the address.
          yield { type: 'result', value: { ok: true, account: acct.address } };
          return;
        }

        case 'remove-account': {
          if (!accountsStore) throw new Error('email accounts store is not ready');
          // Remove by tag/id/address so a stale reference can be cleared, not just a raw id.
          const acct = await resolveAccount(ctx, act.account);
          const removed = await accountsStore.delete(acct.id);
          yield { type: 'result', value: { removed } };
          return;
        }

        case 'accounts': {
          const res = await accountsStore!.query({});
          yield { type: 'result', value: { accounts: res.items } };
          return;
        }

        case 'contacts': {
          const res = await contactsStore!.query({});
          yield { type: 'result', value: { contacts: res.items } };
          return;
        }

        case 'add-contact': {
          if (!contactsStore) throw new Error('email contacts store is not ready');
          const contact: Contact = { id: act.name, version: crypto.randomUUID(), name: act.name, address: act.address, createdAt: now() };
          await contactsStore.set(contact.id, contact);
          yield { type: 'result', value: { added: contact } };
          return;
        }

        case 'remove-contact': {
          const removed = await contactsStore!.delete(act.name);
          yield { type: 'result', value: { removed } };
          return;
        }

        case 'folders': {
          const acct = await resolveAccount(ctx, act.account);
          const client = await connectImap(ctx, acct);
          try {
            // `unseen` only. The other STATUS items each cost a round trip per folder and answer nothing
            // anyone asked; the unread count is what turns "is there anything new?" into one call.
            const boxes = await client.list({ statusQuery: { unseen: true } });
            // Everything, subscribed or not, with `subscribed` reported: a caller that wants to filter can,
            // and a folder hidden by the plugin is one the model cannot reach at all.
            const folders: FolderInfo[] = boxes.map(b => ({
              path: b.path,
              name: b.name,
              delimiter: b.delimiter,
              ...(b.specialUse !== undefined ? { specialUse: b.specialUse } : {}),
              ...(b.specialUseSource !== undefined ? { specialUseSource: b.specialUseSource } : {}),
              subscribed: b.subscribed,
              ...(b.status?.unseen !== undefined ? { unseen: b.status.unseen } : {}),
            }));
            yield { type: 'result', value: { folders } };
          } finally {
            await client.logout();
          }
          return;
        }

        case 'list': {
          const acct = await resolveAccount(ctx, act.account);
          const client = await connectImap(ctx, acct);
          try {
            const mailbox = await client.mailboxOpen(folderOf(act));
            const limit = act.limit ?? 20;
            const total = mailbox.exists;
            // An empty mailbox has no range to ask for: `1:0` is not a sequence set, and the server is
            // entitled to reject it rather than answer "nothing".
            if (total === 0) { yield { type: 'result', value: { messages: [] } }; return; }

            // `since` is a SERVER-side search, not a filter over the newest N: the two differ exactly when
            // it matters, since a quiet week means the newest 20 all predate the date asked about. IMAP
            // SINCE is date-granular (it compares the internal date, ignoring time), so a timestamp is
            // honoured to the day — narrower is not expressible in the protocol.
            let source: string | number[];
            if (act.since !== undefined) {
              const since = new Date(act.since);
              if (Number.isNaN(since.getTime())) {
                yield { type: 'error', message: `"${act.since}" is not a date I can parse — use an ISO date such as 2026-09-01.` };
                return;
              }
              const uids = await client.search({ since }, { uid: true });
              const hits = Array.isArray(uids) ? uids : [];
              if (hits.length === 0) { yield { type: 'result', value: { messages: [] } }; return; }
              source = hits.slice(-limit);          // newest `limit` of the matches; reversed below
            } else {
              source = `${Math.max(1, total - limit + 1)}:${total}`;
            }

            const out: MessageSummary[] = [];
            const opts = typeof source === 'string' ? {} : { uid: true };
            const set  = typeof source === 'string' ? source : source.join(',');
            for await (const msg of client.fetch(set, { envelope: true, flags: true }, opts)) {
              const from = msg.envelope?.from?.[0];
              out.push({
                id: String(msg.uid),
                subject: msg.envelope?.subject ?? '(no subject)',
                from: from ? `${from.name ? from.name + ' ' : ''}<${from.address}>` : '(unknown sender)',
                date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null,
                seen: Array.isArray(msg.flags) && msg.flags.includes('\\Seen'),
              });
            }
            out.reverse(); // newest first
            yield { type: 'result', value: { messages: out } };
          } finally {
            await client.logout();
          }
          return;
        }

        case 'read': {
          const acct = await resolveAccount(ctx, act.account);
          const res = await fetchMessage(ctx, acct, folderOf(act), act.id, act.markSeen ?? false);
          if (res) {
            yield { type: 'result', value: { message: res.detail, attachments: res.attachments } };
          } else {
            yield { type: 'error', message: `No message ${act.id} in ${folderOf(act)}.` };
          }
          return;
        }

        // Permanently remove a message: flag \Deleted and expunge. Destructive and irreversible, so the
        // model should confirm with the user before firing one.
        case 'delete': {
          const acct = await resolveAccount(ctx, act.account);
          const client = await connectImap(ctx, acct);
          let deleted = false;
          let uidValidity: bigint | undefined;
          try {
            const mailbox = await client.mailboxOpen(folderOf(act));
            uidValidity = mailbox.uidValidity;
            deleted = await client.messageDelete(String(act.id), { uid: true });
          } finally {
            await client.logout();
          }
          // The message is gone; any part of it materialised under email_attachments is now unreachable
          // through the tool that made it and would sit in the file store forever. Swept AFTER the
          // logout, and best-effort: the destructive half has already happened, so a failure here is not
          // a failure of the action, and reporting one would say the message survived.
          const attachmentsRemoved = deleted && uidValidity !== undefined
            ? await sweepMessageAttachments(ctx.files, acct.id, folderOf(act), uidValidity, Number(act.id))
            : 0;
          yield { type: 'result', value: { deleted, attachmentsRemoved } };
          return;
        }

        case 'list_attachments': {
          const acct = await resolveAccount(ctx, act.account);
          const res = await fetchStructure(ctx, acct, folderOf(act), act.id);
          if (res) {
            yield { type: 'result', value: { attachments: res.attachments } };
          } else {
            yield { type: 'error', message: `No message ${act.id} in ${folderOf(act)}.` };
          }
          return;
        }

        // Materialise one attachment into the FileStore (email_attachments namespace, allowed) and return
        // its /files/ URL, so the generic route and any frontend can serve it with no email-specific
        // wiring. The part is STREAMED from the server into the store: `put` takes an AsyncIterable and a
        // node Readable is one, so neither the message nor the attachment is ever held whole in memory.
        case 'attachment_url': {
          const acct = await resolveAccount(ctx, act.account);
          if (!ctx.files) { yield { type: 'error', message: 'No file store available to materialise the attachment.' }; return; }
          const open = await openForPart(ctx, acct, folderOf(act), act.id, act.part);
          try {
            if ('error' in open) { yield { type: 'error', message: open.error }; return; }
            const { info } = open;
            const { meta, content } = await open.client.download(String(act.id), act.part, { uid: true });
            // The server's own answer for this part beats the structure's where they differ — it is the
            // header on the bytes actually being sent.
            const mime = ((meta.contentType || info.contentType) ?? 'application/octet-stream') as MimeType;
            const filename = meta.filename ?? info.filename ?? 'attachment';
            const name = attachmentPath(acct.id, folderOf(act), open.uidValidity, Number(act.id), act.part, filename);
            const handle = await ctx.files.put(name, mime, content, { namespace: ATTACH_NS, allowed: true });
            const url = fileUrl(handle);
            if (url === undefined) {
              yield { type: 'error', message:
                `Stored the attachment, but this file store gives it no namespace, so it has no address under ` +
                `/files/ and cannot be linked. It is saved as "${handle.name}".` };
              return;
            }
            yield { type: 'result', value: { url, name: handle.name, bytes: handle.size } };
          } finally {
            await open.client.logout();
          }
          return;
        }

        // Reclaim the file store: drop every materialised attachment whose message no longer exists.
        // Explicit, never automatic — a reconcile costs a connection and a UID search per folder held, and
        // hanging that off an ordinary read would charge every call for a housekeeping job nobody asked for.
        case 'purge_attachments': {
          const acct = await resolveAccount(ctx, act.account);
          if (!ctx.files) { yield { type: 'error', message: 'No file store available, so no attachments have been materialised.' }; return; }
          yield { type: 'result', value: await purgeAccountAttachments(ctx, acct, ctx.files) };
          return;
        }

        // Put one attachment in front of the model's eyes (model-content), never persisting the bytes.
        case 'attachment_show': {
          const acct = await resolveAccount(ctx, act.account);
          const open = await openForPart(ctx, acct, folderOf(act), act.id, act.part);
          try {
            if ('error' in open) { yield { type: 'error', message: open.error }; return; }
            const { info } = open;
            const mime = (info.contentType ?? 'application/octet-stream') as MimeType;
            const arm = showArm(mime);
            if (arm === null) {
              yield { type: 'error', message: `Attachment part "${act.part}" is ${mime}, which is better read than shown.` };
              return;
            }
            // Refused on the DECLARED size, before a byte is fetched. Truncating instead would hand the
            // model half a PDF, which is not a smaller answer but a corrupt one.
            if (info.size !== null && info.size > SHOW_MAX_BYTES) {
              yield { type: 'error', message:
                `Attachment part "${act.part}" is ${Math.round(info.size / 1024 / 1024)}MB, too large to put in ` +
                `context. Use attachment_url to give the user a link to it instead.` };
              return;
            }
            const { content } = await open.client.download(String(act.id), act.part, { uid: true });
            const chunks: Buffer[] = [];
            let total = 0;
            for await (const chunk of content) {
              total += (chunk as Buffer).length;
              // A server may under-report, or report nothing at all: the declared size is a claim, and the
              // stream is the fact. Stop rather than fill the context on the strength of a wrong number.
              if (total > SHOW_MAX_BYTES) {
                content.destroy();
                yield { type: 'error', message:
                  `Attachment part "${act.part}" is larger than its declared size and exceeds the show limit. ` +
                  `Use attachment_url instead.` };
                return;
              }
              chunks.push(chunk as Buffer);
            }
            const bytes = Buffer.concat(chunks);
            const data = bytes.toString('base64');
            yield { type: 'model-content', content: [arm === 'document'
              ? { type: 'document', data, mimeType: mime, name: info.filename ?? 'attachment' }
              : { type: arm, data, mimeType: mime }] };
            yield { type: 'result', value: { name: info.filename ?? 'attachment', mimeType: mime, bytes: bytes.length } };
          } finally {
            await open.client.logout();
          }
          return;
        }

        case 'send': {
          const acct = await resolveAccount(ctx, act.account);
          const to = await Promise.all((Array.isArray(act.to) ? act.to : [act.to]).map(a => contactAddress(ctx, a)));
          const transporter = await smtpTransport(ctx, acct);
          const attachments = await buildAttachments(ctx, act.attach);
          const result = await transporter.sendMail({
            from: acct.address, to, subject: act.subject, text: act.body,
            ...(act.replyTo ? { replyTo: act.replyTo } : {}),
            ...(attachments.length ? { attachments } : {}),
          });
          yield { type: 'result', value: { ok: true, messageId: result.messageId } };
          return;
        }

        case 'reply': {
          const acct = await resolveAccount(ctx, act.account);
          const client = await connectImap(ctx, acct);
          let original: Awaited<ReturnType<typeof client.fetchOne>>;
          try {
            await client.mailboxOpen(folderOf(act));
            original = await client.fetchOne(String(act.id), { source: true, envelope: true }, { uid: true });
          } finally {
            await client.logout();
          }
          if (!original) {
            yield { type: 'error', message: `No message ${act.id} to reply to.` };
          } else {
            const parsed = await simpleParser(original.source as Buffer);
            const to = parsed.replyTo?.value?.[0]?.address ?? original.envelope?.from?.[0]?.address;
            if (!to) {
              yield { type: 'error', message: 'Could not determine the original sender to reply to.' };
            } else {
              const transporter = await smtpTransport(ctx, acct);
              const attachments = await buildAttachments(ctx, act.attach);
              // What makes this a reply rather than a new message with a "Re:" subject. A client threads
              // on In-Reply-To/References, never on the subject line, so without these the reply opens a
              // fresh thread in the recipient's mailbox and reads as a non-sequitur. References is the
              // original's own chain plus its id — the chain is what keeps a long thread together, and
              // dropping it re-roots the conversation at this message.
              const parentId = parsed.messageId;
              const chain = [
                ...(typeof parsed.references === 'string' ? parsed.references.split(/\s+/)
                    : Array.isArray(parsed.references) ? parsed.references : []),
                ...(parentId !== undefined ? [parentId] : []),
              ].filter(Boolean);
              await transporter.sendMail({
                from: acct.address, to,
                subject: parsed.subject?.startsWith('Re: ') ? parsed.subject : `Re: ${parsed.subject ?? '(no subject)'}`,
                text: act.body,
                ...(parentId !== undefined ? { inReplyTo: parentId } : {}),
                ...(chain.length ? { references: chain } : {}),
                ...(attachments.length ? { attachments } : {}),
              });
              yield { type: 'result', value: { ok: true } };
            }
          }
          return;
        }

        default:
          yield { type: 'error', message: `Unknown email_action action.` };
      }
    },
  },
};

// ── Plugin spec ────────────────────────────────────────────────────────────────

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'IMAP/SMTP email over a generic mail server: configure one or more accounts (passwords in the '
      + 'vault), list/read/delete messages in any folder, send and reply with proper threading, address '
      + 'people by name via a contact map, '
      + 'and work with attachments — metadata only, shown to the model, or materialised to a servable URL.',
  },
  tools: [emailTool],
  async setup(services: MatbotMachine): Promise<void> {
    accountsStore = services.createStore<Account>(ACCOUNTS_NS);
    contactsStore = services.createStore<Contact>(CONTACTS_NS);
    machine       = services;
  },
};

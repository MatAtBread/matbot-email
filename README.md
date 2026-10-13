# @matatbread/matbot-email

IMAP/SMTP email tools for matbot — list, read, delete, send and reply to mail on a
generic mail server, and work with its attachments, without leaving the conversation.

## What it does

A single `email_action` tool with a discriminated union of actions:

| Action | Purpose |
|---|---|
| `configure` | Record an account (IMAP + SMTP host/port/TLS) and stash its password in the vault |
| `set-password` | Update an account's password in the vault |
| `remove-account` | Forget an account's metadata (the vault secret is left in place) |
| `accounts` | List configured accounts |
| `contacts` | List the name→address contact map |
| `add-contact` | Map a person's name to an email address |
| `remove-contact` | Remove that mapping |
| `folders` | List the mailboxes, with special-use flags and unread counts |
| `list` | Fetch the newest messages (`limit`, default 20), or those `since` a date |
| `read` | Fetch one message's body and its attachment metadata |
| `delete` | Flag `\Deleted` and expunge — irreversible |
| `list_attachments` | Attachment metadata only: part, filename, type, size, disposition, cid |
| `attachment_show` | Put one attachment in front of the **model's** eyes; bytes are never persisted |
| `attachment_url` | Materialise one attachment into the file store and return a servable `/files/` URL for the **user** |
| `purge_attachments` | Reconcile materialised attachments against the server and delete the orphans |
| `send` | Send a message, filing a copy in `Sent` (confirm with the user first) |
| `reply` | Reply to an existing message, filing a copy in `Sent` (confirm with the user first) |

### Sent copies

SMTP delivers; it does not file a copy — that is the client's job, which is why a message sent
by a plugin that only talks to SMTP reaches its recipient and appears nowhere in the sender's
own mailbox. So `send` and `reply` compose the message **once**, hand those bytes to SMTP and
`APPEND` the same bytes to the account's `\Sent` folder over IMAP (flagged `\Seen`). The copy
is therefore byte-identical to what was delivered, `Message-ID` included, rather than a second
rendering that would thread as a different message; the result reports the folder in `sentCopy`.

The delivery has already happened by then, so a filing failure is reported as `sentCopyError`
beside `ok: true` and never as a send failure — the one thing that must not happen is a retry
that mails the recipient twice. Two accounts need configuring:

- a server that files its own copies (Gmail, for mail submitted to its own SMTP) would show
  everything twice — `configure` it with `saveSent: false`;
- a server reporting no `\Sent` mailbox has nowhere portable to file to, so pass an explicit
  `sentFolder` path from `folders`. A name is never guessed.

Both settings survive a later `configure` that does not mention them.

Every action that addresses a mailbox takes an optional `folder`, defaulting to `INBOX`. A
message `id` is a UID, which is unique only *within* one folder — so the folder passed
to `read`/`delete`/`attachment_*` must be the one the `list` came from.

Folder names are not guessable: the same folder is `Sent`, `INBOX.Sent` or `[Gmail]/Sent Mail`
depending on the server. `folders` returns each mailbox's `path` (the string to pass back)
along with its `specialUse` flag — `\Sent`, `\Drafts`, `\Trash`, `\Junk`, `\Archive` — which is
the portable way to ask for one, plus `unseen` so "any unread mail?" is a single call. It
reports subscribed and unsubscribed mailboxes alike, with `subscribed` on each, since a
folder the plugin hid would be one the model could not reach.

`specialUseSource` says how the flag was determined: `extension` is the server's own
SPECIAL-USE/XLIST answer, `name` is imapflow matching known localised folder names — a
guess, and worth distrusting.

`list` with `since` (an ISO date) runs a server-side IMAP `SINCE` search rather than
filtering the newest few, which is the difference that matters after a quiet week. IMAP
compares dates only, so the time of day in a timestamp is ignored.

The whole point of the contacts map is so you can say *"email Fred and ask if
the invoice is settled"* instead of spelling out a full address. Lookup is an
exact, case-sensitive match on the contact name; anything containing `@` is
passed through as an address.

`attachment_show` and `attachment_url` are the two halves of the media contract and
are not interchangeable: `show` yields `model-content` (image / audio / PDF), which
the model can see and which dies with the turn; `url` writes the bytes into the
`email_attachments` namespace with `allowed: true` and hands back a link. Neither
marks the message read — both fetch via `BODY.PEEK`.

## Attachment lifetime

`attachment_url` is the only action that keeps anything. A materialised part is stored under
`<account-id>/<folder>/<uidvalidity>/<uid>/<part>/<filename>`, so one attachment is stored once
and re-served by name — and the address is reversible, which is what makes cleaning up a prefix
match rather than a second index to keep in step.

All three of folder, UIDVALIDITY and UID are needed to name a message. A UID is unique only
within one mailbox, and only for as long as that mailbox keeps its UIDVALIDITY — which is
precisely the value a server bumps to say *"forget every UID you hold, they mean something else
now"*. Without it, a rebuilt mailbox re-serves a stale file under a UID naming a different
message: a cache hit on the wrong message, which is worse than a miss because nothing looks wrong.

Two mechanisms reclaim the space, because there are two ways a message goes:

- **`delete` sweeps after itself.** Every part of the message it just expunged is dropped from the
  file store. Best-effort by contract, and reported as `attachmentsRemoved`: the destructive half
  has already happened, so a failure to tidy up is not a failure of the action — reporting one
  would say the message survived.
- **`purge_attachments` reconciles.** This is the mechanism that matters, because the ordinary case
  is a message deleted from webmail or a phone, which this plugin never hears about. It opens each
  folder it holds files for, asks for the live UIDs once, and deletes what no longer exists. A stale
  UIDVALIDITY generation is an orphan with no round trip at all. It reports `removed`, `bytes`,
  `kept` and `unchecked`.

It is **explicit, never automatic**: a reconcile costs a connection and a UID search per folder
held, and hanging that off an ordinary read would charge every call for housekeeping nobody asked
for. It is also conservative on every uncertainty — a folder that will not open is counted in
`unchecked` and never emptied, since failing to check is not evidence of absence.

`read` returns the body once, as `text` — mailparser's plain text, HTML-to-text converted
when the message carries no plain part. A tool result is persisted in the transcript and
re-sent on every later round, so a second copy of a body is paid for the life of the session.

## How accounts and credentials work

An account's **id** is a stable SHA-256 of `address`, `imapHost` and `imapPort`, so
reconfiguring the same mailbox reuses the same record and the same credential. The
`account` parameter you pass to `configure` is a human **tag** ("mat", "work"); every
other action resolves `account` against tag, id or address, and falls back to the
single configured account when omitted.

The mailbox password lives in matbot's **vault** under `email_<id>_password`, written
by `configure` (when you supply one) or `set-password`. It is never stored in the
account record; each connect re-derives the key from the id and resolves it with
`ctx.vault.resolve('${email_<id>_password}')`.

Account metadata lives in the `email_accounts` store and contacts in `email_contacts`
(both created in `setup()`); materialised attachments go to the `email_attachments`
file namespace, never into the user's workspace.

## TLS

`useTLS` and `smtpTLS` are two separate facts, because the commonest setup answers them
differently: IMAP 993 and SMTP 465 are implicit TLS, while SMTP 587 is plaintext upgraded
by STARTTLS and needs `smtpTLS: false`. `smtpTLS` defaults from `smtpPort` (true for 465,
false otherwise), so you rarely pass it. When it is false the transport sets `requireTLS`,
making the upgrade mandatory — "not implicit TLS" never degrades to sending in the clear.

## Install from matbot CLI or web UI

...over http
```
Add the plugin at https://raw.githubusercontent.com/MatAtBread/matbot-email/main/
```

...or from npm
```
Add the plugin at @matatbread/matbot-email
```

or, against a checkout:
```
Add the plugin at /path/to/matbot-email
```

Provisioning installs `imapflow`, `nodemailer` and `mailparser` into the plugin's
own `node_modules`, and **links** the host's `@matatbread/matbot-plugin-api` (never
a second copy). The package ships TypeScript source (`exports` points at
`src/index.ts`); there is no build step.

## First use

1. Say to matbot: `Configure the email plugin`.

2. Optionally build the contacts map: `I want to add some email contact names` or `Add Fred as an email contact. His address is fred@example.net`

3. Then you can say:
   - *"check the emails from Fred and tell me if anything needs answering urgently"* → the model calls `list`, then `read`s the relevant ones.
   - *"email Fred that the invoice is settled"* → the model calls `send` (after confirming with you).
   - *"what's on the invoice he attached?"* → `list_attachments`, then `attachment_show`.

## Safety notes

- `send`, `reply` and `delete` change the mailbox. They're signposted as side-effects
  in the tool description, and the model is steered to confirm with you first.
  `delete` expunges, so it is not recoverable.
- Attachments served through `attachment_url` are written with `allowed: true`, i.e.
  anyone who can reach the `/files/` route can fetch them.
- The **default account** is the single configured one. If you configure several,
  pass `account` explicitly to disambiguate.

## Layout

```
package.json        # peer: plugin-api; deps: imapflow/nodemailer/mailparser
tsconfig.json       # types: ["node"]
src/index.ts        # the email_action tool + plugin spec
src/structure.ts    # BODYSTRUCTURE walk: which MIME leaves are attachments
src/attachments.ts  # attachment addressing + file-store cleanup (no plugin-api values, so testable)
src/mailparser.d.ts # local types for mailparser, which ships none
```

## Known limitations / open items

- **`attachment_url` returns a `/files/` URL, which is the *web* frontend's route.** The
  `dom` frontend answers the same question with a `blob:` URL, so a link handed out here
  means nothing there. A tool cannot invoke another tool, and returning a bare file name
  would push resolution onto every frontend, so this is a stated coupling rather than a
  claim of neutrality.
- A sent copy is filed from **this** machine, so a server-side rule that files or re-files sent
  mail itself is not detected — `saveSent: false` is the switch, and there is no way to ask a
  server whether it does.
- `reply` threads correctly (`In-Reply-To`/`References`) but replies only to the sender —
  it does not copy the original's other recipients.
- `read` returns plain text; a message with no text part relies on mailparser's
  HTML-to-text conversion, which does not cover every multipart shape.
- `purge_attachments` is per **account**, and reconciles only folders it currently holds files
  for. An attachment saved from a folder that has since been renamed is indistinguishable from one
  whose folder was deleted, so it is treated as an orphan and reclaimed.
- Per-principal gating (multi-user deployments) is not wired in — this is a
  single-user plugin. The destructive arms would need gating on `currentPrincipal()`
  before a multi-user rollout.

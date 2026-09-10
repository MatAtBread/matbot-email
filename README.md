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
| `list` | Fetch the newest messages (`limit`, default 20), or those `since` a date |
| `read` | Fetch one message's body and its attachment metadata |
| `delete` | Flag `\Deleted` and expunge — irreversible |
| `list_attachments` | Attachment metadata only: part, filename, type, size, disposition, cid |
| `attachment_show` | Put one attachment in front of the **model's** eyes; bytes are never persisted |
| `attachment_url` | Materialise one attachment into the file store and return a servable `/files/` URL for the **user** |
| `send` | Send a message (confirm with the user first) |
| `reply` | Reply to an existing message (confirm with the user first) |

Every action that addresses a mailbox takes an optional `folder`, defaulting to `INBOX`. A
message `id` is a UID, which is unique only *within* one folder — so the folder passed
to `read`/`delete`/`attachment_*` must be the one the `list` came from.

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

## Install

```bash
plugin add @matatbread/matbot-email
```

or, against a checkout:

```bash
plugin add /path/to/matbot-email
```

Provisioning installs `imapflow`, `nodemailer` and `mailparser` into the plugin's
own `node_modules`, and **links** the host's `@matatbread/matbot-plugin-api` (never
a second copy). The package ships TypeScript source (`exports` points at
`src/index.ts`); there is no build step.

## First use

1. `email_action { action: "configure", account: "me", address: "me@example.com", imapHost: "imap.example.com", imapPort: 993, smtpHost: "smtp.example.com", smtpPort: 465, useTLS: true, password: "…" }`

   (If you'd rather not pass the password this way, `configure` without it and use
   `set-password` later.)

2. Optionally build the contacts map:
   `email_action { action: "add-contact", name: "Fred", address: "fred@example.com" }`

3. Then you can say, in plain language:
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
src/mailparser.d.ts # local types for mailparser, which ships none
```

## Known limitations / open items

- **`attachment_url` returns a `/files/` URL, which is the *web* frontend's route.** The
  `dom` frontend answers the same question with a `blob:` URL, so a link handed out here
  means nothing there. A tool cannot invoke another tool, and returning a bare file name
  would push resolution onto every frontend, so this is a stated coupling rather than a
  claim of neutrality.
- `reply` threads correctly (`In-Reply-To`/`References`) but replies only to the sender —
  it does not copy the original's other recipients.
- `read` returns plain text; a message with no text part relies on mailparser's
  HTML-to-text conversion, which does not cover every multipart shape.
- Each of `read`, `list_attachments`, `attachment_show` and `attachment_url` fetches and
  parses the whole message, so viewing two attachments costs three full downloads.
- Materialised attachment paths carry no UIDVALIDITY, so a mailbox that reissues its UIDs
  can re-serve a stale file under a UID that now names a different message.
- Per-principal gating (multi-user deployments) is not wired in — this is a
  single-user plugin. The destructive arms would need gating on `currentPrincipal()`
  before a multi-user rollout.

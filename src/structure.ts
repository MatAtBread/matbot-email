// The MIME walk, kept free of every matbot import on purpose: it is pure logic over the server's
// BODYSTRUCTURE, it is the one judgement in this plugin that is easy to get subtly wrong, and a module
// that imports nothing can be unit-tested by plain `node --test` — which cannot strip types from the
// TypeScript source that plugin-api ships under node_modules.

import type { MessageStructureObject } from 'imapflow';

// Metadata about a MIME attachment. The model reasons over this; the bytes stay on the server until asked.
export interface AttachmentInfo {
  part: string;
  filename: string | null;
  contentType: string | null;
  size: number | null;
  inline: boolean;
  cid: string | null;       // Content-ID, for inline/referenced images
}

// Attachment metadata comes from the server's BODYSTRUCTURE, never from parsing the message.
//
// This is the whole point: BODYSTRUCTURE is the MIME tree WITHOUT the bodies — a few hundred bytes for a
// message carrying 20MB of PDFs — and every field below is in it. Parsing for this downloaded the entire
// message, attachments and all, base64-inflated by a third, to read a filename.
//
// It also settles addressing. `part` is now the IMAP part number, which is the exact string `download`
// takes, so metadata and bytes cannot disagree about which part is which. mailparser's `partId` was
// derived independently and could be null for a message with no boundary — two such attachments then
// shared one address.
export function collectStructure(node: MessageStructureObject | undefined): AttachmentInfo[] {
  const out: AttachmentInfo[] = [];
  if (node === undefined) return out;

  const walk = (n: MessageStructureObject, isRoot: boolean): void => {
    const type = (n.type ?? '').toLowerCase();
    // A multipart node is structure, not content: it holds no bytes of its own.
    if (n.childNodes !== undefined && type.startsWith('multipart/')) {
      for (const child of n.childNodes) walk(child, false);
      return;
    }

    const disposition = (n.disposition ?? '').toLowerCase();
    const filename = n.dispositionParameters?.['filename'] ?? n.parameters?.['name'];
    // What separates an attachment from the message body. An explicit disposition is the server's own
    // answer and is taken at its word; failing that, a filename means someone attached a file. A bare
    // text part with neither is the body being read — which is why a plain-text email yields no
    // attachments rather than one attachment containing the message.
    const isBody = disposition === '' && filename === undefined && type.startsWith('text/');
    if (isBody) return;
    if (isRoot && disposition === '' && filename === undefined) return;

    out.push({
      // A single-part message has no part number of its own; "1" is what addresses its body.
      part: n.part ?? '1',
      filename: filename ?? null,
      contentType: n.type ?? null,
      size: n.size ?? null,
      inline: disposition === 'inline',
      cid: n.id !== undefined ? n.id.replace(/^<|>$/g, '') : null,
    });
  };

  walk(node, true);
  return out;
}

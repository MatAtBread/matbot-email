// Minimal type declarations for mailparser (v3.9.x), which ships no bundled types and has no @types
// package at the version the plugin resolves. The shape below mirrors the runtime attachment object
// built in lib/mail-parser.js (partId, content, contentType, filename, contentDisposition, contentId,
// cid, related, size) so the plugin's attachment arms are type-safe. This is plugin-local and does not
// leak into the host.
declare module 'mailparser' {
  export interface MailAttachment {
    type: 'attachment';
    partId: string;
    content: Buffer;
    contentType?: string;
    filename?: string;
    contentDisposition?: string;
    contentId?: string;
    cid?: string;
    related?: boolean;
    checksum?: string;
    size?: number;
  }
  export interface ParsedMail {
    subject?: string;
    text?: string;
    // The threading headers. `references` is a space-separated string on the wire; mailparser hands back
    // an array when the header repeats, so both shapes are real.
    messageId?: string;
    references?: string | string[];
    html?: string | false;
    replyTo?: { value?: { address?: string }[] };
    attachments?: MailAttachment[];
  }
  export function simpleParser(source: Buffer | string): Promise<ParsedMail>;
}

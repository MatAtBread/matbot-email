// Minimal type declarations for mailparser (v3.9.x), which ships no bundled types and has no @types
// package at the version the plugin resolves. Only what the plugin reads is declared: the message body
// and the headers a reply needs. Attachments are deliberately absent — they come from the server's
// BODYSTRUCTURE, which describes them without downloading them. This is plugin-local and does not leak
// into the host.
declare module 'mailparser' {
  export interface ParsedMail {
    subject?: string;
    text?: string;
    // The threading headers. `references` is a space-separated string on the wire; mailparser hands back
    // an array when the header repeats, so both shapes are real.
    messageId?: string;
    references?: string | string[];
    html?: string | false;
    replyTo?: { value?: { address?: string }[] };
  }
  export function simpleParser(source: Buffer | string): Promise<ParsedMail>;
}

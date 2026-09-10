// BODYSTRUCTURE is the server's description of a message's MIME tree, and deciding which of its leaves
// are "attachments" is the one judgement this plugin makes that mailparser used to make for it. These are
// the shapes real mail actually arrives in — the single-part PDF and the .txt attachment are the two that
// a naive walk gets wrong, in opposite directions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MessageStructureObject } from 'imapflow';
import { collectStructure, type AttachmentInfo } from '../src/structure.ts';

const cases: [string, MessageStructureObject, AttachmentInfo[] | string[]][] = [
  ['plain text message',
    { type: 'text/plain', size: 400 }, []],

  ['multipart/alternative (text + html)',
    { type: 'multipart/alternative', childNodes: [
      { type: 'text/plain', part: '1' }, { type: 'text/html', part: '2' } ] }, []],

  ['html mail with a PDF attached',
    { type: 'multipart/mixed', childNodes: [
      { type: 'multipart/alternative', part: '1', childNodes: [
        { type: 'text/plain', part: '1.1' }, { type: 'text/html', part: '1.2' } ] },
      { type: 'application/pdf', part: '2', size: 51200, disposition: 'attachment',
        dispositionParameters: { filename: 'invoice.pdf' } } ] },
    [{ part: '2', filename: 'invoice.pdf', contentType: 'application/pdf', size: 51200, inline: false, cid: null }]],

  ['inline image referenced by cid',
    { type: 'multipart/related', childNodes: [
      { type: 'text/html', part: '1' },
      { type: 'image/png', part: '2', size: 900, disposition: 'inline', id: '<logo@x>',
        dispositionParameters: { filename: 'logo.png' } } ] },
    [{ part: '2', filename: 'logo.png', contentType: 'image/png', size: 900, inline: true, cid: 'logo@x' }]],

  ['a message that IS a PDF (single part, no boundary)',
    { type: 'application/pdf', size: 2048, disposition: 'attachment',
      dispositionParameters: { filename: 'scan.pdf' } },
    [{ part: '1', filename: 'scan.pdf', contentType: 'application/pdf', size: 2048, inline: false, cid: null }]],

  ['a .txt ATTACHMENT is not the body',
    { type: 'multipart/mixed', childNodes: [
      { type: 'text/plain', part: '1' },
      { type: 'text/plain', part: '2', size: 30, dispositionParameters: { filename: 'notes.txt' },
        disposition: 'attachment' } ] },
    [{ part: '2', filename: 'notes.txt', contentType: 'text/plain', size: 30, inline: false, cid: null }]],

  ['name= with no disposition still counts',
    { type: 'multipart/mixed', childNodes: [
      { type: 'text/plain', part: '1' },
      { type: 'image/jpeg', part: '2', size: 100, parameters: { name: 'photo.jpg' } } ] },
    [{ part: '2', filename: 'photo.jpg', contentType: 'image/jpeg', size: 100, inline: false, cid: null }]],

  ['two attachments keep distinct parts',
    { type: 'multipart/mixed', childNodes: [
      { type: 'text/plain', part: '1' },
      { type: 'application/pdf', part: '2', disposition: 'attachment', dispositionParameters: { filename: 'a.pdf' } },
      { type: 'application/pdf', part: '3', disposition: 'attachment', dispositionParameters: { filename: 'b.pdf' } } ] },
    ['2', '3']],
];

for (const [name, tree, expected] of cases) {
  test(name, () => {
    const got = collectStructure(tree);
    if (Array.isArray(expected) && typeof expected[0] === 'string') {
      assert.deepEqual(got.map((a: AttachmentInfo) => a.part), expected);
    } else {
      assert.deepEqual(got, expected);
    }
  });
}

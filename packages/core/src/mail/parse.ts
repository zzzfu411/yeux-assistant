import { createHash } from 'node:crypto';
import { simpleParser, type AddressObject, type ParsedMail as Parsed } from 'mailparser';
import { AppError } from '../common.js';
import type { ParsedMail } from './ingest.js';
import { isBulk } from './thread.js';

const addresses = (value: AddressObject | AddressObject[] | undefined) =>
  (Array.isArray(value) ? value : value ? [value] : [])
    .flatMap((group) => group.value)
    .map((item) => (item.address || '').trim())
    .filter(Boolean);
const options = { skipTextToHtml: true, skipImageLinks: true } as const;

/** Plain text first; an HTML-only message is converted to text and marked as such. */
export async function parseMail(raw: Buffer, owner: string): Promise<ParsedMail> {
  if (raw.length > 10_000_000) throw new AppError('邮件超过 10 MB，原文已保留。');
  let parsed: Parsed = await simpleParser(raw, { ...options, skipHtmlToText: true });
  let body = typeof parsed.text === 'string' ? parsed.text.trim() : '',
    origin: 'plain' | 'html' = 'plain';
  if (!body && typeof parsed.html === 'string' && parsed.html.trim()) {
    parsed = await simpleParser(raw, { ...options, skipHtmlToText: false });
    body = typeof parsed.text === 'string' ? parsed.text.trim() : '';
    origin = 'html';
  }
  if (!body) throw new AppError('邮件正文为空，原文已隔离保留，请在邮箱查看。');
  const subject = (parsed.subject || '(无主题)').replace(/[\r\n]+/g, ' ').trim();
  const from = addresses(parsed.from)[0] || '';
  const replyTo = addresses(parsed.replyTo)[0] || null;
  const to = addresses(parsed.to),
    cc = addresses(parsed.cc);
  if (
    [...body].length > 100000 ||
    [...subject].length > 300 ||
    from.length > 320 ||
    /[\x00]/.test(body + subject + from)
  )
    throw new AppError('邮件内容超出可导入范围，原文已完整保留。');
  const references = (
    Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : []
  )
    .flatMap((value) => value.split(/\s+/))
    .filter((value) => /^<[^<>\s]+>$/.test(value))
    .slice(-20);
  return {
    messageId: parsed.messageId && /^<[^<>\s]+>$/.test(parsed.messageId) ? parsed.messageId : null,
    inReplyTo: parsed.inReplyTo && /^<[^<>\s]+>$/.test(parsed.inReplyTo.trim()) ? parsed.inReplyTo.trim() : null,
    references,
    from,
    to,
    cc,
    replyTo,
    subject,
    sentAt: parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date : null,
    body,
    origin,
    bulk: isBulk(parsed.headers, owner, to, cc),
    attachments: parsed.attachments
      .filter((item) => item.contentDisposition !== 'inline' || item.filename)
      .slice(0, 20)
      .map((item) => ({
        filename: (item.filename || '未命名附件').slice(0, 200),
        contentType: item.contentType.slice(0, 100),
        size: item.size,
      })),
    rawDigest: createHash('sha256').update(raw).digest('hex'),
  };
}

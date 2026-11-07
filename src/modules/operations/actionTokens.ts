import { createHash, randomBytes } from 'node:crypto';
import { Schema } from 'mongoose';
import { ObjectId } from '../../core/masters/schema.js';
import type { Plain } from '../../core/masters/types.js';
import { sendWhatsApp } from './marichiTalks.js';
import { opsModel } from './models/model.js';
import type { MessageButton, Post } from './support.js';

/**
 * A button sent to a person on WhatsApp carries a one-time token. Only the token comes back, so the
 * webhook runs only actions the server actually offered, to that person, once. Tokens are stored hashed.
 */
const actionTokenSchema = new Schema<any>({
  hash: { type: String, required: true },
  userId: { type: ObjectId, ref: 'User', required: true },
  phone: { type: String, required: true },
  label: { type: String, required: true },
  command: { type: Schema.Types.Mixed, required: true },
  expiresAt: { type: Date, required: true },
  usedAt: Date,
}, { timestamps: true, versionKey: false });
actionTokenSchema.index({ hash: 1 }, { unique: true });
actionTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 86400 });

export const ActionToken = opsModel('ActionToken', actionTokenSchema);

const TOKEN_DAYS = 7;
const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

/** Sends a message to one person on WhatsApp; each button with a command gets its own token. */
export async function sendButtons(userId: string, phone: string, message: Post, buttons: MessageButton[]) {
  const offered: Array<{ label: string; token?: string }> = [];
  for (const button of buttons) {
    if (!button.action) continue;
    const token = randomBytes(24).toString('base64url');
    await ActionToken.create({ hash: hashOf(token), userId, phone, label: button.label, command: button.action, expiresAt: new Date(Date.now() + TOKEN_DAYS * 86400000) });
    offered.push({ label: button.label, token });
  }
  await sendWhatsApp({
    to: phone, title: message.title, text: message.text ?? '', buttons: offered.map((b) => b.label), tokens: offered.map((b) => b.token!),
    use: { template: 'approval_request', values: [message.title ?? 'A request', message.text || 'Open the app for the details.'] },
  });
}

/**
 * A tapped quick reply over a WhatsApp connection (#112) comes back as the button's text, not its token: the
 * newest unused button with that text sent to this number is used, once.
 */
export async function redeemByLabel(label: string, phones: string[]): Promise<{ userId: string; command: Plain } | null> {
  const used = await ActionToken.findOneAndUpdate(
    { label, usedAt: { $exists: false }, expiresAt: { $gt: new Date() }, phone: { $in: phones } },
    { $set: { usedAt: new Date() } },
    { sort: { createdAt: -1 }, returnDocument: 'after' },
  ).lean();
  return used ? { userId: String(used.userId), command: used.command as Plain } : null;
}

/** Uses a token once: it must be unused, unexpired and sent to this number. Returns the person and the command. */
export async function redeem(token: string, phones: string[]): Promise<{ userId: string; command: Plain } | null> {
  const used = await ActionToken.findOneAndUpdate(
    { hash: hashOf(token), usedAt: { $exists: false }, expiresAt: { $gt: new Date() }, phone: { $in: phones } },
    { $set: { usedAt: new Date() } },
    { returnDocument: 'after' },
  ).lean();
  return used ? { userId: String(used.userId), command: used.command as Plain } : null;
}

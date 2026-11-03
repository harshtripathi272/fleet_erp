import type { RequestHandler } from 'express';
import { Types } from 'mongoose';
import { AppError, ConflictError, ValidationError } from '../core/errors/index.js';
import { IdempotencyKey } from '../core/idempotency/idempotency.model.js';

const KEY = /^[A-Za-z0-9_-]{8,100}$/;
/** A request still "running" after this long died with its server; a retry takes the key over. */
const ABANDONED_MS = 2 * 60_000;

/**
 * `Idempotency-Key: <id>` makes a request safe to send again, e.g. from a phone that lost its signal before
 * the answer arrived. The first request with a key runs; a repeat by the same person gets the stored answer
 * (with `Idempotent-Replayed: true`) and creates nothing. Only successful answers are kept, so a request that
 * failed or was refused can be tried again with the same key. Without the header, nothing changes.
 * Mount after `authenticate`.
 */
export const idempotent: RequestHandler = async (req, res, next) => {
  const key = req.get('idempotency-key');
  if (!key) return next();
  if (!KEY.test(key)) throw new ValidationError('Idempotency-Key must be 8-100 letters, digits, - or _');
  const userId = new Types.ObjectId(req.auth!.userId);
  const route = `${req.method} ${req.baseUrl}${req.path}`;
  try {
    await IdempotencyKey.create({ userId, key, route, state: 'running', at: new Date() });
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
    const seen = await IdempotencyKey.findOne({ userId, key }).lean();
    if (!seen) throw new ConflictError('This is still being sent. Try again in a moment.');
    if (seen.route !== route) throw new ValidationError('This Idempotency-Key was used for another request');
    if (seen.state === 'done') {
      res.setHeader('Idempotent-Replayed', 'true');
      res.status(seen.status ?? 200).json(seen.body);
      return;
    }
    const takenOver = seen.at.getTime() < Date.now() - ABANDONED_MS
      && (await IdempotencyKey.updateOne({ _id: seen._id, state: 'running', at: seen.at }, { $set: { at: new Date() } })).modifiedCount === 1;
    if (!takenOver) throw new AppError('This is still being sent. Try again in a moment.', 409, 'IDEMPOTENCY_IN_PROGRESS');
  }
  // Settle when the handler answers, not when the connection ends: a phone that drops mid-request must not
  // free the key while the request is still running, or its retry would run it twice.
  let settled = false;
  const settle = (status: number, body: unknown) => {
    if (settled) return;
    settled = true;
    const done = status >= 200 && status < 300 && body !== undefined
      ? IdempotencyKey.updateOne({ userId, key }, { $set: { state: 'done', status, body } })
      : IdempotencyKey.deleteOne({ userId, key, state: 'running' });
    done.catch(() => undefined);
  };
  const json = res.json.bind(res);
  res.json = (value: unknown) => {
    settle(res.statusCode, value);
    return json(value);
  };
  // An answer without a JSON body (none of these routes send one) is not kept.
  res.on('finish', () => settle(res.statusCode, undefined));
  next();
};

import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { app } from '../src/app.js';
import { env, envSchema } from '../src/config/env.js';
import { ConflictError, InternalServerError } from '../src/core/errors/index.js';
import { ApiResponse, buildPaginationMeta } from '../src/core/response/index.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { requestId } from '../src/middleware/requestId.js';
import { validate } from '../src/middleware/validate.js';
import { asyncHandler } from '../src/utils/asyncHandler.js';

test('health endpoint returns the standard envelope and a fresh request ID', async () => {
  const first = await request(app).get('/api/v1/health').expect(200);
  const second = await request(app).get('/api/v1/health').expect(200);
  assert.equal(first.body.success, true);
  assert.equal(first.body.data.status, 'ok');
  assert.equal(typeof first.headers['x-request-id'], 'string');
  assert.match(first.headers['x-request-id']!, /^[0-9a-f-]{36}$/);
  assert.notEqual(first.headers['x-request-id'], second.headers['x-request-id']);
});

test('unknown routes use a correlated 404 error envelope', async () => {
  // An API path: other paths are the web app's own routes once web/dist is built.
  const result = await request(app).get('/api/missing').expect(404);
  assert.equal(result.body.success, false);
  assert.equal(result.body.error.code, 'NOT_FOUND');
  assert.equal(result.body.requestId, result.headers['x-request-id']);
});

test('invalid health query is rejected through validation middleware', async () => {
  const result = await request(app).get('/api/v1/health?unexpected=true').expect(422);
  assert.equal(result.body.error.code, 'VALIDATION_ERROR');
  assert.ok(result.body.error.details.query.formErrors.length);
});

test('malformed JSON and excessive payloads are client errors', async () => {
  const malformed = await request(app).post('/api/v1/health').set('Content-Type', 'application/json').send('{').expect(400);
  assert.equal(malformed.body.error.code, 'BAD_REQUEST');
  assert.ok(malformed.body.requestId);
  const large = await request(app).post('/api/v1/health').send({ content: 'a'.repeat(1024 * 1024) }).expect(413);
  assert.equal(large.body.error.code, 'PAYLOAD_TOO_LARGE');
});

function validationApp() {
  const fixture = express();
  fixture.use(requestId, express.json());
  fixture.post('/items/:id', validate({
    params: z.object({ id: z.coerce.number().int().positive() }),
    query: z.object({ page: z.coerce.number().int().positive().default(1) }),
    body: z.object({ name: z.string().trim().min(1), enabled: z.boolean().default(true) }),
  }), asyncHandler(async (req, res) => {
    ApiResponse.created(res, { params: req.params, query: req.query, body: req.body });
  }));
  fixture.use(errorHandler);
  return fixture;
}

test('validation replaces body, params, and Express 5 query with coerced values', async () => {
  const result = await request(validationApp()).post('/items/42?page=3').send({ name: '  Test  ', unknown: true }).expect(201);
  assert.deepEqual(result.body.data, { params: { id: 42 }, query: { page: 3 }, body: { name: 'Test', enabled: true } });
  const defaults = await request(validationApp()).post('/items/1').send({ name: 'Default' }).expect(201);
  assert.equal(defaults.body.data.query.page, 1);
});

test('validation reports field errors for all invalid request targets', async () => {
  const result = await request(validationApp()).post('/items/invalid?page=-1').send({ name: '' }).expect(422);
  assert.ok(result.body.error.details.params.fieldErrors.id);
  assert.ok(result.body.error.details.query.fieldErrors.page);
  assert.ok(result.body.error.details.body.fieldErrors.name);
});

test('async service errors propagate to the global error handler', async () => {
  const fixture = express();
  fixture.use(requestId);
  fixture.get('/', asyncHandler(async () => { throw new ConflictError('Already exists', { field: 'email' }); }));
  fixture.use(errorHandler);
  const result = await request(fixture).get('/').expect(409);
  assert.deepEqual(result.body.error, { code: 'CONFLICT', message: 'Already exists', details: { field: 'email' } });
});

test('production responses hide unexpected failure details', async () => {
  const previous = env.NODE_ENV;
  env.NODE_ENV = 'production';
  try {
    const fixture = express();
    fixture.use(requestId);
    fixture.get('/', asyncHandler(async () => { throw new InternalServerError('private diagnostic'); }));
    fixture.use(errorHandler);
    const result = await request(fixture).get('/').expect(500);
    assert.equal(result.body.error.message, 'Internal server error');
    assert.equal(result.body.error.details, undefined);
    assert.equal(result.body.error.stack, undefined);
  } finally { env.NODE_ENV = previous; }
});

test('response helpers support both guide message signatures and no-content', async () => {
  const fixture = express();
  fixture.get('/string', (_req, res) => ApiResponse.success(res, {}, 'Done'));
  fixture.get('/object', (_req, res) => ApiResponse.success(res, [], { message: 'Done' }));
  fixture.get('/empty', (_req, res) => ApiResponse.noContent(res));
  fixture.get('/pages', (_req, res) => ApiResponse.paginated(res, [{ id: 1 }], buildPaginationMeta(41, 2, 20)));
  for (const path of ['/string', '/object']) {
    const result = await request(fixture).get(path).expect(200);
    assert.equal(result.body.message, 'Done');
  }
  assert.equal((await request(fixture).get('/empty').expect(204)).text, '');
  const result = await request(fixture).get('/pages').expect(200);
  assert.deepEqual(result.body.meta, { page: 2, limit: 20, total: 41, totalPages: 3, hasNextPage: true, hasPrevPage: true });
  assert.equal(buildPaginationMeta(0, 1, 20).totalPages, 0);
  assert.throws(() => buildPaginationMeta(1, 1, 0));
});

test('environment schema fails fast for invalid configuration', () => {
  assert.equal(envSchema.parse({}).PORT, 3000);
  assert.equal(envSchema.parse({ PORT: '3001' }).PORT, 3001);
  for (const values of [{ PORT: 'no' }, { PORT: '0' }, { NODE_ENV: 'invalid' }, { SHUTDOWN_TIMEOUT_MS: '-1' }]) {
    assert.equal(envSchema.safeParse(values).success, false);
  }
});

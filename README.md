# Fleet ERP backend foundation

Initialized from the supplied `marichi-code-standard-guide.pdf`. Business requirements are pending; the only application endpoint is a liveness check. No database, authentication, or business modules have been selected or implemented.

## Run locally

Requires Node.js 22 or newer and npm.

```powershell
npm ci
# Optional: copy .env.example to .env and adjust settings.
npm run dev
```

Open http://127.0.0.1:3000/api/v1/health. The response is JSON with `success: true` and `data.status: "ok"`. This checks the running server only, not external dependency readiness. The API binds to loopback by default; set `HOST=0.0.0.0` when deploying in a container.

```powershell
npm run check  # Type checking, HTTP integration tests, production compilation
npm run build
npm start
```

## Structure and conventions

- `src/app.ts`: middleware and versioned route mounting; `notFound` and `errorHandler` stay last.
- `src/server.ts`: listening, SIGINT/SIGTERM request draining, bounded shutdown, and fatal process handlers.
- `src/config/env.ts`: the sole environment access point, validated by Zod.
- `src/core/`: Pino logger, typed application errors, response and pagination helpers.
- `src/middleware/`: UUID request IDs, request logging, validation, 404 and error handling.
- `src/modules/health/`: minimal example of schema -> router -> controller -> service.
- `tests/foundation.test.ts`: HTTP behavior and infrastructure contract checks.

For a new feature, create `<feature>.schema.ts`, `<feature>.router.ts`, `<feature>.controller.ts`, and `<feature>.service.ts` under `src/modules/<feature>/`, then mount the router at `/api/v1/<feature>` in `app.ts`. Validate route params as well as body/query. Controllers use `asyncHandler` and `ApiResponse`; services accept data, contain business logic, and throw typed errors. Keep request/response objects out of services. Use the structured logger instead of console calls.

Node ESM imports use `.js` extensions in TypeScript source so compiled code runs directly. Development logs are pretty; production logs are JSON. Request logs omit headers, bodies, and query strings. Production responses hide non-operational error details. `.env` and generated output are ignored by Git.

## Guide compatibility

Express 5 exposes `req.query` as a getter ([migration guide](https://expressjs.com/en/guide/migrating-5/#req.query)). The validation middleware creates a request-local property after successful parsing so the guide's parsed/coerced `req.body`, `req.query`, and `req.params` contract remains intact. Integration tests exercise it through real Express routing.

The PDF uses both string and object messages for `ApiResponse.success`; both are supported. Zod 4's `z.flattenError` preserves the documented `fieldErrors`/`formErrors` response shape. Numeric inputs must use coercion plus integer/range checks, rather than unbounded string-to-number transforms.

This repository (`harshtripathi272/fleet_erp`) is a new foundation. The older Fleet ERP prototype described in the context vault is in a different repository and has not been copied or modified.

# Building the React app against this API

The agreed frontend stack is **React + TanStack (Query, Router, Table, Form) + shadcn/ui**. The frontend lives in its own repository or folder; this repository is the API. While you build, run this API locally ([Windows setup](SETUP-WINDOWS.md)) and point the app at it.

The API's behaviour (sections 3 and 4) is how the backend works today. The rest (proxy setup, code sketch, folder and library choices inside the stack) are suggestions; organise the app however works best.

## 1. Connect the app to the API

One simple way is the Vite dev proxy. The browser then talks to one address, so there is nothing to configure for CORS:

```ts
// vite.config.ts
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
});
```

The app calls `/api/v1/...` and Vite forwards it to the API on port 3000.

If you prefer to call the API directly (`http://127.0.0.1:3000/api/v1/...`), add the app's address to the API's `.env` and restart the API:

```
CORS_ORIGINS=http://localhost:5173
```

## 2. Know the models before you build screens

- **http://127.0.0.1:3000/console/** lists every model in order of importance, with its fields, links and rules. No sign-in.
- `GET /api/v1/meta/models` returns the same thing as JSON: every field with type, required, choices and the model it links to. It can drive forms and tables, so field lists need not be retyped.
- **Test the API** in the console sends any request with real ids filled in, and shows the exact response. Use it to see a shape before writing the code for it.

## 3. Sign-in

| Call | Body | Returns |
| --- | --- | --- |
| `POST /api/v1/auth/register` | `{ name, email, password }` | tokens, plus `firstOwner: true` for the first account |
| `POST /api/v1/auth/login` | `{ email, password }` | tokens |
| `POST /api/v1/auth/refresh` | `{ refreshToken }` | new tokens; the old refresh token stops working |
| `GET /api/v1/auth/me` | | the user, their roles and permissions |
| `POST /api/v1/auth/logout` | | ends this device's session |
| `POST /api/v1/auth/forgot-password` | `{ email }` | always succeeds, so it cannot be used to probe e-mails |
| `POST /api/v1/auth/reset-password` | `{ token, password }` | |

Tokens come back as `{ accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt }`.

- Send `Authorization: Bearer <accessToken>` on every call except `/health` and `/auth/*`.
- The access token lasts **15 minutes**. On a `401`, call `/auth/refresh` once with the refresh token, store the new pair, and retry the request. If the refresh also fails, send the user to sign-in.
- Refresh tokens are **single use**. Reusing an old one ends that device's session, as a stolen-token defence. So two browser tabs or two parallel requests must not refresh with the same token at the same time; let one request refresh and the others wait for it.
- A password reset or "sign out everywhere" ends every session of that user.
- Use `GET /auth/me` permissions to hide buttons the user's role cannot use. The API checks again either way.

## 4. Reading and writing records

Every model has the same endpoints, so one set of hooks covers all of them.

| Call | Notes |
| --- | --- |
| `GET /api/v1/<model>` | `page`, `limit` (1–100), `search`, `status` (`active`, `inactive`, `archived`, `all`; archived are hidden by default), `sort` (`field` or `-field`), plus each model's own filters |
| `GET /api/v1/<model>/:id` | one record |
| `POST /api/v1/<model>` | create |
| `PATCH /api/v1/<model>/:id` | send only what changed **plus the `version` you loaded**. `null` clears an optional field |
| `POST /api/v1/<model>/:id/archive` and `/restore` | archive instead of delete |
| `DELETE /api/v1/<model>/:id` | only works when nothing refers to the record |
| `GET /api/v1/<model>/:id/usage` | what refers to it |
| `GET /api/v1/<model>/:id/history` | every change, who made it, from and to |

Responses always look like this:

```json
{ "success": true, "data": [ ... ], "meta": { "page": 1, "limit": 20, "total": 54, "totalPages": 3, "hasNextPage": true, "hasPrevPage": false } }
```

```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Validation failed", "details": { ... } }, "requestId": "..." }
```

Things a screen has to handle:

- **409 CONFLICT** on save means someone changed the record after you loaded it (stale `version`), or a unique value is taken. Reload and show the user what changed.
- **422 VALIDATION_ERROR**: `details` names each failing field; show the messages next to the fields.
- **Unknown fields are rejected.** Send only the fields of that model.
- **Money** is `{ amountMinor, currencyId }` in whole minor units: K 1,250.50 is `amountMinor: 125050` with the ZMW currency id. Divide by `10^minorUnits` of the currency to show it.
- **Dates** are `YYYY-MM-DD` for calendar dates (expiry, birthday) or full ISO date-times with a time zone.
- **Links** between records are ids. Fetch the linked model's list for dropdowns (`GET /api/v1/parties?search=...&status=active`).

## 5. A sketch in code

```ts
// api.ts: one possible fetch wrapper. Adapt freely.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAccessToken()}`, ...init.headers },
  });
  const body = await res.json();
  if (!res.ok) throw Object.assign(new Error(body.error?.message ?? res.statusText), { status: res.status, ...body.error });
  return body as T;
}

// With TanStack Query:
const vehicles = useQuery({
  queryKey: ['vehicles', { page, search }],
  queryFn: () => api<{ data: Vehicle[]; meta: PageMeta }>(`/vehicles?page=${page}&search=${encodeURIComponent(search)}`),
});
```

Add the 401 → refresh → retry step inside `api()`, as in section 3.

## 6. Look and feel

The clickable mock (trip-flow, in the separate `laksh-ya/fleet-erp` repository) sets the visual language: paper-coloured canvas, dark pine-green sidebar, Instrument Sans, quiet tables. The console in `public/console` uses the same materials. See the UI guidance in [Project context](PROJECT-CONTEXT.md#ui-guidance) for what has worked and what was rejected so far.

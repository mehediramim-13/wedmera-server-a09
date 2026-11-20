# WedMera - Wedding Planning Platform

WedMera is an Express.js and MongoDB backend for a wedding planning marketplace. Vendors publish and manage wedding services, customers discover services and create bookings, administrators moderate the marketplace, and vendors purchase Premium subscriptions through Stripe.

## Important features

- Better Auth JWT verification through a remote JWKS endpoint
- Database-backed roles, blocking, ownership, and effective subscription plans
- Public category and service discovery with search, filters, sorting, pagination, and featured listings
- Vendor service CRUD, availability controls, and free-plan limits
- Customer booking creation, cancellation, and booking history
- Vendor booking accept/reject workflows
- Admin moderation, user blocking, analytics, and read-only transaction reporting
- Verified Stripe Checkout and webhook subscription lifecycle
- ImgBB image uploads

## Tech stack

- Node.js ES modules
- Express 5
- MongoDB native driver
- JOSE for JWT/JWKS verification
- Zod validation
- Stripe Checkout, subscriptions, and webhooks
- Multer, ImgBB, CORS, Helmet, and express-rate-limit
- Vercel serverless deployment

## Installation

```bash
npm install
cp .env.example .env
```

Fill in all required values in `.env`, then run:

```bash
npm run dev
```

Production-style start:

```bash
npm start
```

With the client and API running, verify admin service moderation with:

```bash
npm run test:admin-services
```

The test creates temporary users and a temporary service, then removes them.

The server listens on `PORT` (default `5000`) outside Vercel.

## Required application URLs

| Purpose | Local | Live placeholder |
|---|---|---|
| Client | `http://localhost:3000` | `https://your-client.vercel.app` |
| Server | `http://localhost:5000` | `https://your-server.vercel.app` |
| Better Auth JWKS | `http://localhost:3000/api/auth/jwks` | `https://your-client.vercel.app/api/auth/jwks` |
| Stripe webhook | `http://localhost:5000/api/webhooks/stripe` | `https://your-server.vercel.app/api/webhooks/stripe` |

For local Stripe testing:

```bash
stripe listen --forward-to localhost:5000/api/webhooks/stripe
```

Copy the generated `whsec_...` value into `STRIPE_WEBHOOK_SECRET`.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | No | Local server port |
| `NODE_ENV` | No | Application environment |
| `MONGODB_URL` | Yes | MongoDB connection string |
| `DB_NAME` | Yes | MongoDB database name |
| `USERS_COLLECTION` | No | Better Auth users collection; defaults to `user` |
| `CLIENT_URL` | Yes | Comma-separated allowed client origins |
| `SERVER_URL` | No | Public server URL |
| `JWKS_URL` | Yes | Better Auth JWKS endpoint |
| `JWT_ISSUER` | No | Optional JWT issuer claim |
| `JWT_AUDIENCE` | No | Optional JWT audience claim |
| `APP_TIMEZONE` | No | Timezone used for date rules |
| `FREE_PLAN_SERVICE_LIMIT` | No | Free-plan active service limit; default 3 |
| `STRIPE_SECRET_KEY` | Yes | Stripe server secret |
| `STRIPE_WEBHOOK_SECRET` | Yes | Stripe webhook signing secret |
| `STRIPE_PRICE_ID` | Yes | Recurring Premium price ID |
| `IMGBB_API_KEY` | Yes | ImgBB upload API key |
| `ADMIN_EMAIL` | Seed only | Email promoted by the seed script |
| `BETTER_AUTH_URL` | Client-side only | Better Auth base URL |
| `BETTER_AUTH_SECRET` | Client-side only | Better Auth secret |
| `GOOGLE_CLIENT_ID` | Client-side only | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Client-side only | Google OAuth secret |

Never commit `.env`.

## API endpoints

| Method | Path | Access |
|---|---|---|
| GET | `/` | Public |
| GET | `/api/health` | Public |
| GET | `/api/categories` | Public |
| GET | `/api/services` | Public |
| POST | `/api/upload` | Public |
| POST | `/api/webhooks/stripe` | Stripe signature |
| GET | `/api/users/me` | Authenticated |
| PATCH | `/api/users/me` | Authenticated |
| GET | `/api/services/:id` | Authenticated |
| POST | `/api/bookings` | Customer |
| GET | `/api/customer/overview` | Customer |
| GET | `/api/customer/bookings` | Customer |
| GET | `/api/customer/bookings/:id` | Customer/owner |
| PATCH | `/api/customer/bookings/:id/cancel` | Customer/owner |
| GET | `/api/vendor/overview` | Vendor |
| GET | `/api/vendor/services` | Vendor |
| POST | `/api/vendor/services` | Vendor |
| PATCH | `/api/vendor/services/:id` | Vendor/owner |
| PATCH | `/api/vendor/services/:id/availability` | Vendor/owner |
| DELETE | `/api/vendor/services/:id` | Vendor/owner |
| GET | `/api/vendor/bookings` | Vendor |
| PATCH | `/api/vendor/bookings/:id/accept` | Vendor/owner |
| PATCH | `/api/vendor/bookings/:id/reject` | Vendor/owner |
| GET | `/api/vendor/subscription` | Vendor |
| GET | `/api/vendor/transactions` | Vendor/owner |
| POST | `/api/payments/create-checkout-session` | Vendor |
| GET | `/api/payments/session/:sessionId` | Vendor/owner |
| POST | `/api/payments/cancel-subscription` | Vendor |
| GET | `/api/admin/overview` | Admin |
| GET | `/api/admin/users` | Admin |
| GET | `/api/admin/users/:id` | Admin |
| PATCH | `/api/admin/users/:id/block` | Admin |
| PATCH | `/api/admin/users/:id/unblock` | Admin |
| GET | `/api/admin/services` | Admin |
| PATCH | `/api/admin/services/:id` | Admin |
| PATCH | `/api/admin/services/:id/status` | Admin (legacy alias) |
| DELETE | `/api/admin/services/:id` | Admin |
| GET | `/api/admin/transactions` | Admin |

Send protected requests with `Authorization: Bearer <token>`.

## Status and category constants

Service statuses: `Pending`, `Approved`, `Rejected`

Booking statuses: `Pending`, `Accepted`, `Rejected`, `Cancelled`

User roles: `vendor`, `customer`, `admin`

Service categories:

- `Photography & Videography`
- `Wedding Venues`
- `Decoration & Florist`
- `Catering Services`
- `Makeup & Styling`
- `Wedding Fashion`

## Admin seeding

Admin accounts cannot be created through public registration. In the Better Auth client configuration, the `role` additional field must accept only `vendor` or `customer` during sign-up.

1. Sign up normally on the client using `ADMIN_EMAIL`.
2. Set `ADMIN_EMAIL` in the server `.env`.
3. Run:

```bash
npm run seed:admin
```

The existing Better Auth user is promoted to `admin`. Log out and sign in again so the client receives the updated role information.

## Vercel deployment

1. Set all required environment variables in Vercel.
2. Keep `api/index.js` as the serverless entry and use `vercel.json` to rewrite routes.
3. Set `JWKS_URL` to the live Better Auth client JWKS endpoint.
4. Set `CLIENT_URL` to the live client URL (or comma-separated origins).
5. Register `https://your-server.vercel.app/api/webhooks/stripe` in Stripe.
6. Subscribe to: `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, and `checkout.session.async_payment_failed`.

Local repository placeholder: `https://github.com/your-account/wedmera-server`

Client repository placeholder: `https://github.com/your-account/wedmera-client`

Live server placeholder: `https://your-wedmera-server.vercel.app`

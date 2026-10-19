# Revolt-X OS Core

Revolt-X OS is a standalone, multi-tenant business operating platform. This repository contains the horizontal Core OS only. Vertical products integrate through scoped module clients, versioned APIs and transactional outbox events. Revolt-X AI remains outside the core and is reached only through the AI Gateway adapter.

## Implemented foundation

- PostgreSQL tenant, user, membership, branch, department and team model
- Password authentication, short-lived JWT access tokens, rotated refresh tokens and revocable sessions
- Tenant-scoped RBAC with granular permissions and scoped role assignments
- Immutable audit records for security and business mutations
- Operations Hub work items with ownership, priority, status, optimistic concurrency and module references
- Versioned workflow definitions, steps, activation, execution, idempotency and persisted step runs
- External module clients and a transactional event outbox for SDK/API integration
- Isolated AI Gateway proxy with tenant and user context propagation
- Runtime validation, structured errors, security headers, CORS and rate limiting

## Local setup

```bash
cp .env.example .env
docker compose up -d postgres
npm install
npm run db:migrate
npm run build
npm test
npm run dev
```

The first organisation and owner are created with `POST /v1/auth/register-organisation`. Passwords require at least 12 characters with upper-case, lower-case and numeric characters. Use the returned bearer token for tenant APIs.

## Administrator-created accounts

Create users in People & Access with a temporary password of at least 12 characters including uppercase, lowercase and a number. `POST /v1/users` requires `temporaryPassword` alongside the user's name, email and role.

The first sign-in returns `requiresPasswordChange: true` and a restricted five-minute session. The user must set a different personal password at `/change-password`; workspace APIs and refresh are blocked until this is completed. `POST /v1/auth/change-password` accepts `currentPassword` and `newPassword`, revokes existing OS sessions and requires a new sign-in. School credentials remain separate. An administrator-assigned School administrator password also requires a change on first sign-in.

## Architectural boundaries

All tables holding business state carry an `organisation_id`, and every endpoint derives the tenant from a verified session rather than accepting it from request data. Future modules must use module credentials, `/v1` APIs and `outbox_events`; they must not add vertical tables or logic to Core OS. AI providers and prompts belong behind `AI_GATEWAY_URL`, never in this service.

See [docs/architecture.md](docs/architecture.md) and [docs/api.md](docs/api.md).

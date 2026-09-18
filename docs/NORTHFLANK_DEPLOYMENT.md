# Revolt-X OS on Northflank

## Application service

Deploy the repository root with the included Dockerfile.

- Runtime: Dockerfile
- Container port: `3000`
- Health check: `GET /health/ready`
- Liveness check: `GET /health/live`
- Minimum instance count: `1`

## PostgreSQL

Provision PostgreSQL in the same Northflank project and expose its private connection URL to the application as `DATABASE_URL`.

The application creates the `revolt_x_os` schema and runs committed SQL migrations at startup.

## Required environment variables

```text
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
DATABASE_URL=<Northflank PostgreSQL private connection URL>
DB_POOL_MAX=5
JWT_SECRET=<strong random secret, at least 32 characters>
ACCESS_TOKEN_TTL_SECONDS=900
REFRESH_TOKEN_TTL_DAYS=30
CORS_ORIGINS=<deployed public origin>
AI_GATEWAY_URL=
AI_GATEWAY_TOKEN=
```

Do not commit secrets to GitHub.

## Startup

The container executes:

```text
npm start
```

which runs `dist/server.js`. Before listening, the server:

1. connects to PostgreSQL;
2. ensures the `revolt_x_os` schema exists;
3. applies pending SQL migrations from `/migrations`;
4. starts Fastify on `0.0.0.0:3000`.

## Verification

After deployment:

- `GET /health/live` must return `{"status":"ok"}`
- `GET /health/ready` must return `{"status":"ready"}`
- `GET /` must render the Revolt-X OS interface.

The temporary preview-session access is development-only and must be removed before a public commercial launch.

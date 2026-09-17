# API summary

Public: `POST /v1/auth/register-organisation`, `POST /v1/auth/login`, `POST /v1/auth/refresh`, `GET /health/live`, `GET /health/ready`.

Authenticated APIs include organisation settings; users; roles; branches; departments; teams; operation items; workflow definitions and instances; audit records; module clients; and AI Gateway invocation. Responses use JSON. Errors use `{ "error": { "code", "message", "details?", "requestId" } }`.

Access tokens are passed as `Authorization: Bearer <token>`. The registration and login responses also include a rotating refresh token. The plaintext secret returned when creating a module client is shown once and is never stored.

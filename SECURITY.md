# Security

## Threat model

The realtime service treats every room capability token as a bearer secret. An
attacker may control HTTP bodies, headers, socket handshake data, origins,
command envelopes, media URLs, and connection timing. They must not be able to
read or mutate another room, promote themselves, replay a command, exhaust
memory/CPU, or cause the server to fetch an attacker-selected URL. The database
and deployment environment are trusted boundaries; the role in a client
request is never authoritative (roles come from the authenticated participant
record).

Controls include per-command authentication and host authorization, strict
bounded Zod payloads, capability hashes (tokens are never persisted in clear),
socket/HTTP origin allow-lists, rate limiting, serialized room commands,
bounded replay deduplication, generic client errors, and URL validation that
performs no server-side fetch. Containers expose only the realtime/web ports;
database and Redis remain on the internal network.

## Reporting a vulnerability

Please do not disclose a suspected vulnerability publicly. Report it privately
to the project maintainers with the affected version/commit, reproduction
steps, impact, and any relevant logs with tokens or personal data removed.
Allow maintainers reasonable time to investigate and release a fix. Never
include live capability tokens, database credentials, or private URLs in a
report.

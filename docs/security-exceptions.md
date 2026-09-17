# Security Exceptions and Dependency Risk Register

**Owner:** Project maintainers  
**Recorded:** 2026-09-17  
**Expiry/review deadline:** 2026-12-16  
**Status:** Temporary exceptions; no waiver permits `npm audit fix --force` or a breaking upgrade without review.

## Scope and current result

The production-only npm audit contains **9 findings: 5 moderate and 4 high, with
0 critical**. The **4 high findings remain open**. No compatible, safe semver
fix is available in the currently supported dependency lines. The audit's
available fixes are either `true` (a dependency-line change requiring separate
compatibility work) or explicitly marked semver-major (`next@16.3.5` or
`minio@7.1.3`). No package.json or package-lock update was retained.

The exact package paths below are dependency-tree paths, not machine-local
filesystem paths. The npm JSON supplied no CVE identifiers; therefore `CVE: —`
means no CVE was listed by npm for that finding, not that a CVE was inferred.

## Findings

### 1. Prisma configuration chain

- **Packages/severity:** `@prisma/config` — High; `deepmerge-ts` — High;
  `prisma` — High.
- **Advisories:** `GHSA-ggr8-5vv4-36mx` (source ID `1145093`, recursive merge
  stack exhaustion); `CVE: —` in the audit JSON.
- **Paths:**
  - `packages/database/node_modules/@prisma/config` via `prisma -> @prisma/config -> deepmerge-ts`
  - `node_modules/deepmerge-ts` via `@prisma/config`
  - `packages/database/node_modules/prisma` via `@prisma/config`
- **fixAvailable:** `true` for `@prisma/config`, `deepmerge-ts`, and `prisma`;
  npm did not provide a compatible fixed Prisma 6.x version.
- **Reachability/rationale:** Prisma is a production dependency. Realtime
  invokes Prisma migration at startup, and Prisma configuration handling is
  therefore reachable. No untrusted configuration input was identified in the
  application request paths; the advisory is retained because the production
  dependency is present.
- **Mitigation:** Keep Prisma on the tested 6.x line; do not force a major
  upgrade. Runtime images prune dev dependencies after Prisma generation while
  retaining production Prisma packages. Limit configuration and migration
  inputs to deployment-controlled values.
- **Review trigger:** A compatible Prisma patch, a Prisma major migration plan,
  a new configuration ingestion path, or any exploit involving recursive
  configuration objects.

### 2. MinIO URI decoding chain

- **Packages/severity:** `minio` — Moderate; `query-string` — Moderate;
  `decode-uri-component` — Moderate.
- **Advisory:** `GHSA-vcc3-ghjq-m6fr` (source ID `1147955`, exponential decoding
  denial of service); `CVE: —` in the audit JSON.
- **Paths:**
  - `node_modules/minio` via `query-string` and `stream-json`
  - `node_modules/query-string` via `decode-uri-component`
  - `node_modules/decode-uri-component` via `minio -> query-string`
- **fixAvailable:** `{ name: "minio", version: "7.1.3", isSemVerMajor: true }`.
- **Reachability/rationale:** MinIO is used by realtime and media-worker for
  object storage. The vulnerable parser is transitive and requires malformed
  percent-encoded input to reach the denial-of-service behavior.
- **Mitigation:** Keep MinIO 8.x; validate and bound externally supplied media
  and object-storage identifiers before client operations. Do not downgrade to
  the npm-recommended major-incompatible MinIO version without testing.
- **Review trigger:** A MinIO 8.x fix, a change to storage URL construction, a
  report of attacker-controlled storage identifiers, or a DoS reproduction.

### 3. MinIO nested JSON parser chain

- **Package/severity:** `stream-json` — Moderate.
- **Advisory:** `GHSA-528h-pc64-c93x` (source ID `1164823`, quadratic nested-input
  denial of service); `CVE: —` in the audit JSON.
- **Path:** `node_modules/stream-json` via `minio`.
- **fixAvailable:** `{ name: "minio", version: "7.1.3", isSemVerMajor: true }`.
- **Reachability/rationale:** Reachable only through MinIO's transitive JSON
  processing. Exploitation requires crafted deeply nested input and a path that
  causes the affected filters to process it.
- **Mitigation:** Keep MinIO 8.x, bound media/object metadata sizes, and retain
  the existing request and upload limits. Runtime images use
  `npm prune --omit=dev` to reduce production attack surface.
- **Review trigger:** A patched MinIO 8.x release, any new untrusted JSON path
  into storage operations, or observed event-loop starvation.

### 4. Next/PostCSS build chain

- **Packages/severity:** `next` — Moderate; `postcss` — Moderate/High.
- **Advisories:**
  - `GHSA-qx2v-qp2m-jg93` (source ID `1117015`, Moderate, XSS via unescaped
    `</style>` output)
  - `GHSA-6g55-p6wh-862q` (source ID `1124252`, High, arbitrary file read via
    attacker-controlled `sourceMappingURL`)
  - `GHSA-fxqj-rqcc-2cmp` (source ID `1130709`, Moderate, incomplete fix for
    source-map disclosure)
  - `GHSA-r28c-9q8g-f849` (source ID `1139510`, High, path traversal via prior
    source-map loading)
  - `CVE: —` for all four in the audit JSON.
- **Paths:** `node_modules/next` via `postcss`; `node_modules/postcss` via
  `next` (`postcss@8.4.31` in the audited tree).
- **fixAvailable:** `{ name: "next", version: "16.3.5", isSemVerMajor: true }`.
- **Reachability/rationale:** Next/PostCSS is used during the web build. The
  web image uses Next standalone output, so PostCSS is not shipped in the final
  runtime image. No application-controlled CSS/source-map parser endpoint was
  identified.
- **Mitigation:** Keep tested Next 15.x; do not apply the major Next 16 fix as a
  security-only change. Continue using standalone output and review generated
  artifacts before release.
- **Review trigger:** A compatible Next 15/PostCSS fix, any runtime inclusion of
  PostCSS, attacker-controlled source-map processing, or a planned Next major
  upgrade.

## LiveKit image exception

- **Finding:** `GO-2026-5932`, affecting `golang.org/x/crypto/openpgp` and its
  subpackages; severity is not a CVE score in the Go report and no CVE is
  listed.
- **Pinned asset:** `livekit/livekit-server:v1.13.7` at the existing digest;
  the digest was intentionally not changed.
- **Assessment:** Upstream tag `v1.13.7` was inspected. Its `go.mod` contains
  `golang.org/x/crypto` as an indirect module, while source search found no
  `openpgp` imports. This supports non-reachability but is not a substitute for
  call-graph analysis.
- **Limitation:** `govulncheck` and the Go toolchain were unavailable in the
  verification environment, so no executable call-graph result was obtained.
- **Mitigation:** Keep the digest pinned; do not replace the image speculatively.
  Treat scanner-only module presence as insufficient proof of reachable
  `openpgp` code.
- **Review trigger:** `govulncheck` becomes available, upstream adds an
  `openpgp` import, LiveKit publishes a relevant remediation, or the pinned
  image changes.

## Verification record

- `npm run prisma:generate` is the repository's exact database generation
  command (`db:generate` does not exist).
- Host typecheck/build are to be rerun after generation; Docker builds also
  generate Prisma before building and apply the production prune mitigation.
- Re-review all exceptions by **2026-12-16**, or sooner on any trigger above.

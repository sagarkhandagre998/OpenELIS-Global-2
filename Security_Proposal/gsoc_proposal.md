# GSoC 2025 Proposal — Security Hardening for OpenELIS Global 2

**Applicant:** [Your Name]
**Email:** [your@email.com]
**GitHub:** [github.com/yourhandle]
**Time Zone:** [Your timezone]
**Availability:** Full-time, ~40 hours/week for the duration of the program

---

## About Me

I am a backend software engineer with roughly three years of hands-on experience building and securing Java web applications. My day-to-day work involves Spring MVC, PostgreSQL, and Docker-based deployments, so the OpenELIS stack is not foreign territory for me.

What drew me specifically to this project was not a surface-level scan of the issue tracker. I spent several weeks doing a manual audit of the codebase before writing this proposal — tracing auth flows through `SecurityConfig`, `ModuleAuthenticationInterceptor`, the SAML handlers, and the FHIR controllers. I wanted to understand what the actual problems were before proposing how to fix them. The findings I describe below are grounded in specific files, line numbers, and code paths I read myself.

I have previously contributed to open source Java projects (list yours here), written integration tests against Spring context-sensitive test bases, and worked on a HIPAA-adjacent data pipeline where PHI handling requirements were a daily concern. Healthcare software carries obligations that most web applications do not, and I take that seriously.

---

## The Problem

OpenELIS Global 2 is a laboratory information management system deployed in public health facilities across Africa and beyond. It handles patient demographics, diagnostic results, specimen chains of custody, and audit trails that are used for ISO 15189 and SLIPTA compliance. The consequences of a breach here are not abstract — they involve real patients, real clinicians, and regulatory obligations that exist to protect vulnerable people.

After auditing the codebase, I found that the security posture has significant gaps across five distinct layers. These are not theoretical risks constructed from generic checklists. Each one is traceable to a specific method, a specific line of code, and a specific exploit path.

A few examples to illustrate the scope:

The `/session` endpoint in `LoginPageController.java` serialises the raw `JSESSIONID` into a JSON response that `Login.js` polls every three seconds. The `HttpOnly` flag on the cookie, which is correctly set, provides zero protection against this — any XSS payload just calls `fetch('/session')` and reads `sessionId` from the response body.

The `ModuleAuthenticationInterceptor` returns `true` for any REST path that has no `SystemModuleUrl` registration in the database. This is the default for most endpoints. It means every new REST controller a developer adds is automatically accessible to any authenticated user until someone manually registers it in the module permission table. This single design decision is the root cause of at least a dozen broken-access-control findings across the patient search, audit trail, and notification controllers.

The FHIR layer — five distinct surfaces — carries no authorization on any of them. `InternalFhirApi` is a wildcard proxy that forwards raw HTTP requests to the local FHIR store with no path normalization, making it an SSRF vector. `FhirQueryRestController` accepts an arbitrary `{resourceType}` path variable and passes all query parameters through verbatim. `FhirRestfulServer` registers resource providers with no HAPI `IAuthorizationInterceptor`.

The infrastructure has hardcoded credentials in version-controlled files across every compose variant — `adminADMIN!`, `clinlims`, `kspass`, `tspass`, and an AES-256 encryption key that defaults to the string `"dev"` when the property is not set.

None of these are obscure edge cases. They are load-bearing parts of the application that a real attacker would find quickly.

---

## Proposed Work

The goal of this project is to move OpenELIS from its current posture to one that is defensible for a production healthcare deployment. I have broken the work into five phases that build on each other. The ordering is intentional — fixing the authorization framework in Phase 1 reduces the blast radius of every finding in Phases 2 and 3, and fixing secrets hygiene in Phase 5 underpins the deployment security that everything else depends on.

---

### Phase 1 — Authentication and Session Security

**Duration:** Weeks 1–3

This phase addresses the authentication and session management layer, which is the entry point for every other attack surface.

**P1-A1: Remove session ID from the `/session` response**

`LoginPageController.getSesssionDetails()` calls `session.setSessionId(request.getSession().getId())`, which causes Jackson to include `JSESSIONID` in every polling response. The fix is to remove the `sessionId` field from `UserSession.java` and the corresponding call site in the controller. The browser manages the session cookie automatically — there is no legitimate reason for JavaScript to have access to it.

**P1-A2: Validate `X-Forwarded-For` against a trusted proxy range**

Both `CustomFormAuthenticationSuccessHandler` and `CustomAuthenticationFailureHandler` read `request.getHeader("X-Forwarded-For")` and log `xfHeader.split(",")[0]` as the client's IP. Because ports 8080 and 8443 are exposed directly on the host in `docker-compose.yml`, a client can bypass Nginx entirely and forge this header. The audit log — the primary forensic artifact for SLIPTA compliance — records whatever the attacker puts there.

The fix is to register Spring's `ForwardedHeaderFilter` in `SecurityConfig` and configure Tomcat's `RemoteIpValve` with the Docker-internal proxy subnet, then simplify both handlers to a single `request.getRemoteAddr()` call. The valve does the trust resolution before the request reaches application code.

**P1-A3: Remove hardcoded default admin password**

The string `adminADMIN!` appears as a literal fallback in five compose files and in the GitHub Actions workflow (`secrets.TEST_PASS || 'adminADMIN!'`). The fix involves replacing every fallback with the Docker Compose `:?` syntax (`${OE_ADMIN_PASSWORD:?Must be set}`), which aborts startup with a descriptive message if the variable is not supplied. A startup guard in `CreateAdminUserTask.java` will also reject any password matching a known-public set at boot time, before any database write occurs.

**P1-A4: Fix SAML auto-provisioning privilege escalation**

`CustomSSOAuthenticationSuccessHandler.setupUserSession()` calls `systemUser.setSysUserId("1")` when creating a new user record for a first-time SAML login. `sysUserId = "1"` is the admin context — it is the same value assigned to the admin login by `CreateAdminUserTask`. The fix removes this hardcoded call entirely, adds a configurable `sso.auto.provision.enabled` flag defaulting to `false`, and assigns new SSO users a least-privilege role via `userRoleService.addUserToRole()` rather than inheriting the admin context.

**P1-A5: Implement `getGrantedAuthorities()` in `CustomUserDetailsService`**

This method has a TODO comment and returns an empty list unconditionally. As a result, `@PreAuthorize("hasRole('ADMIN')")` on the four `SiteBrandingRestController` endpoints is silently broken for all form-login users — either always denying or always permitting depending on whether `@EnableMethodSecurity` is active. The fix maps the OpenELIS admin flag to `ROLE_ADMIN` and iterates the `user_role` table to produce a complete authority list, making the framework-standard annotation approach reliable for both form-login and SSO paths.

**P1-A6: Change `ModuleAuthenticationInterceptor` from fail-open to fail-closed**

The condition `if (isRestFullPath()) { return true; }` is triggered whenever a REST endpoint has no `SystemModuleUrl` record. The fix inverts this to `return false` and adds a WARN log pointing developers to the action required. An explicit `AUTHENTICATED_OPEN_REST_PATHS` set replaces the implicit fail-open for the handful of paths that genuinely need to be accessible to any authenticated user (session polling, own notifications, VAPID public key).

---

### Phase 2 — Input Validation, Broken Access Control, and Admin Endpoint Hardening

**Duration:** Weeks 4–6

With the authorization framework corrected in Phase 1, Phase 2 addresses the specific endpoints where access control is either completely absent or enforced at the wrong layer.

**P2-A: BOLA on patient and audit endpoints**

`PatientSearchRestController` exposes two endpoints (`/rest/patient-search-results` and `/rest/patient-search`) that return full patient demographics — name, DOB, gender, national ID, GUID, lab numbers — with no role gate. `AuditTrailReportRestController` returns the full change history and patient snapshot for any accession number passed as a query parameter. `UnifiedSystemUserRestController` returns the full user directory.

Each of these needs a service-layer role check added. For the patient search endpoints, the fix is a `@PreAuthorize` annotation scoped to roles that legitimately need search access (lab staff, reception) and a service-layer ownership filter that restricts results to the requester's lab section where applicable. The audit trail endpoint requires the `ROLE_AUDIT_TRAIL` constant defined in `Constants.java` to actually be enforced — it never has been.

**P2-B: Mass deletion endpoint guarded only by a config flag**

`DeletePatientTestDataController` wipes the entire patient and sample database when `TrainingInstallation=true` is set, with no admin role check, no CSRF token, and no confirmation step. The fix adds an `isUserAdmin` check as the first guard, wraps the operation in a double-submit confirmation token, and adds an audit log entry before any deletion begins.

**P2-C: Unguarded administrative endpoints**

Three endpoints need explicit admin gating:

`ImportController` — `/import/all`, `/import/organization`, `/import/provider` trigger mass FHIR data imports. Any authenticated user can call these, flooding the database with external data.

`MassIndexerRestController` — `/rest/reindex` triggers a full Hibernate Search reindex that can saturate CPU and memory for extended periods. Accessible to any authenticated user, this is effectively an authenticated DoS vector.

`LoggingController` — `/logging` lets any authenticated user set arbitrary log levels on any package, including enabling TRACE-level Hibernate SQL logging that writes PHI to disk (the same vulnerability flagged separately as a configuration default).

All three get `isUserAdmin` checks at the controller entry point and corresponding Liquibase changesets to register them in the module permission system.

**P2-D: FHIR resource type allowlist in `FhirQueryRestController`**

The `{resourceType}` path variable is a raw string with no validation. The fix validates it against an explicit set of FHIR R4 resource types relevant to OpenELIS (`Patient`, `Task`, `ServiceRequest`, `DiagnosticReport`, `Observation`, `Specimen`, `Practitioner`, `Encounter`) and returns 400 for anything outside that set. Query parameter forwarding is similarly restricted to a known-safe parameter name list.

---

### Phase 3 — PHI Data Exposure

**Duration:** Weeks 7–9

This phase closes the remaining PHI exposure vectors, most of which are independent endpoints that the Phase 1 and 2 fixes reduce in severity but do not fully close.

**P3-A/B: Patient search and audit trail (defence-in-depth layer)**

Building on Phase 2's role gates, this adds service-layer data filtering so that even a user with the correct role cannot enumerate all patients in the system — results are scoped to their lab section or active work queue. This is a structural change to `PatientSearchService` rather than a controller-level annotation.

**P3-C: Patient photo endpoint**

`PatientManagementRestController.getPhoto()` accepts a raw patient DB ID with no ownership or role check. Base64-encoded facial photos of any patient in the database are accessible to any authenticated session. The fix adds a role check (`ROLE_PATIENT_MANAGEMENT`) and a session-to-patient binding verification — the requesting user must have an active interaction with that patient's sample or be an admin.

**P3-D: Dashboard national ID exposure**

`PatientDashBoardProvider.convertAnalysesToOrderBean()` embeds `patient.getNationalId()` directly into the order bean returned by the dashboard endpoint. The dashboard is intended for workflow summary — it does not need a full national ID. The fix replaces the national ID field with a masked or partial identifier in the DTO used for dashboard responses, keeping the full value accessible only through the dedicated patient detail endpoint (which will be role-gated by this phase).

**P3-E: PHI in application logs**

Two specific log statements in `PatientSearchRestController` write full patient name and national ID at INFO level. These are removed. The broader Hibernate SQL logging default (`logging.level.org.hibernate.type.descriptor.sql.BasicBinder=TRACE`) is moved to a `application-dev.properties` profile that is never activated by any compose file. A `SecurityStartupValidator` component warns loudly at boot time if TRACE-level SQL logging is active.

**P3-F/G: Import controller and user enumeration (additional guards)**

`ImportController` is gated by the Phase 2 admin check. The user enumeration endpoint (`/rest/users`) is restricted to admin role and returns only the minimum fields needed for the notification UI (ID + display name), not full user profiles.

---

### Phase 4 — FHIR Endpoint Security

**Duration:** Weeks 10–11

The FHIR layer is the most structurally complex surface in the codebase. It has five independently routed entry points, none of which carry any authorization.

**P4-A: `FhirQueryRestController` — path traversal and parameter injection**

The fixes from Phase 2 add the resource type allowlist. Phase 4 extends this with path segment normalization (rejecting any value containing `/`, `\`, `.`, or `%`) on both `resourceType` and `resourceId`, and replaces the raw parameter forwarding loop with a named-parameter allowlist. Any request with a parameter name outside the allowlist receives a 400 response.

**P4-B: `InternalFhirApi` — SSRF via wildcard proxy**

The `GET /**` and `POST /**` handlers forward raw HTTP requests to the FHIR store with path extraction done by simple string replacement. There is no path normalization and the query string is appended completely raw. The fix validates `fhirPath` against the same FHIR resource type allowlist from Phase 2, normalizes the path using `URI.normalize()`, rejects any path containing traversal sequences, and removes the wildcard handler in favor of typed resource-specific routes. The raw `HttpGet`/`HttpPost` construction is replaced with typed HAPI FHIR client calls that cannot be pointed at arbitrary internal URLs.

**P4-C: `FhirRestfulServer` — no authentication interceptor**

HAPI FHIR's security model works through registered `IServerInterceptor` instances. The `FhirRestfulServer` registers none. The fix implements a `FhirAuthorizationInterceptor` that validates the caller's Spring Security session, maps the requested operation and resource type against the user's permitted modules, and rejects unauthorized operations with a FHIR `OperationOutcome` response rather than a Spring error page. This interceptor is registered in `FhirRestfulServer.initialize()` before any resource provider is loaded.

**P4-D: Transformation and export endpoints**

`FhirTransformationController` and `FhirExportController` carry no authorization. Both get admin role gates — FHIR export and bulk transformation are administrative operations that should not be triggerable by lab staff.

**P4-E: External patient search TLS**

The `ClientRegistryFhirTransmissionService` builds HTTP connections to the external client registry without TLS certificate verification in several paths. These are corrected to use the trust store configured for the application.

---

### Phase 5 — Infrastructure Hardening and Secrets Management

**Duration:** Weeks 12–13

**P5-A: Hardcoded credentials across compose files**

This is the most operationally impactful change because it requires coordination with deployment documentation. Every hardcoded credential in every compose file is replaced with a required environment variable using Docker Compose's `:?` enforcement syntax:

- `adminADMIN!` → `${OE_ADMIN_PASSWORD:?}`
- `clinlims` (DB password) → `${OE_DB_PASSWORD:?}`
- `admin` (PostgreSQL superuser) → `${OE_DB_SUPERUSER_PASSWORD:?}`
- `kspass` → `${SSL_KEYSTORE_PASSWORD:?}`
- `tspass` → `${SSL_TRUSTSTORE_PASSWORD:?}`
- `encryption.general.password=kspass` → read from Docker secret, never from a property file in VCS

The VAPID private key is removed from `application.properties` and replaced with `${VAPID_PRIVATE_KEY:?}`. A `scripts/generate-vapid-keys.sh` script is added to generate fresh key pairs for new deployments.

The `datasource.password` file committed with the literal string `clinlims` is replaced with a `.gitignore`d template and a note in the deployment documentation about using Docker secrets.

**P5-B: PostgreSQL port binding**

The `ports: - "15432:5432"` binding in `docker-compose.yml` and `dev.docker-compose.yml` exposes the database to any IP that can reach the host. The production compose file drops the binding entirely — Docker internal DNS (`db.openelis.org`) is sufficient for container-to-container communication. The dev compose file changes to `127.0.0.1:15432:5432` for local access only.

**P5-C: Nginx TLS backend verification**

`proxy_ssl_verify off` appears in three location blocks across `nginx.conf` and `nginx-prod.conf`. Each is changed to `proxy_ssl_verify on` with `proxy_ssl_trusted_certificate` pointing to the CA certificate generated by `itechuw/certgen`. The CA certificate is mounted into the Nginx container via the compose volume configuration.

**P5-D: Nginx security response headers**

No security headers are set anywhere in the nginx configuration. A shared `security_headers.conf` snippet is added and included in both `nginx.conf` and `nginx-prod.conf`:

```
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
server_tokens off;
```

**P5-E: AES encryption key fallback**

`SecurityConfig` has `@Value("${encryption.general.password:dev}")` — the fallback is the three-character string `"dev"`. The `:dev` default is removed. A `@PostConstruct` validation in `SecurityConfig` checks the property is set and throws `IllegalStateException` at startup if it is not. The same validation rejects the known-weak values that have been committed to the repository.

**P5-F: Unsigned JAR plugin loading**

`PluginLoader` loads every `.jar` from the plugins volume at startup with no signature check. The fix adds JAR signature verification using a configurable signing certificate. Unsigned JARs are logged and rejected. A `PLUGIN_SIGNING_CERT` environment variable points to the trusted signer's certificate. For the interim while the signing infrastructure is being set up, a SHA-256 checksum allowlist can serve as a fallback mechanism.

---

## Database Migrations

Every finding that requires a new module permission registration or a schema-level change will have a corresponding Liquibase changeset under `src/main/resources/liquibase/`. Structural changesets will include rollback blocks. No direct DDL will be written in Java code.

---

## Testing Plan

I take the existing test infrastructure seriously. The repository uses JUnit 4 (`org.junit.Test`) and a Spring-context-sensitive test base (`BaseWebContextSensitiveTest`). I will not introduce JUnit 5 annotations or `@SpringBootTest` patterns.

For each Phase 1 fix, I will write unit tests using Mockito (`@Mock`, `@InjectMocks`) that verify the actual corrected behavior — not just that a mock returns what a mock was told to return. For example, the `getGrantedAuthorities()` test verifies that loading an admin user produces a `UserDetails` whose `getAuthorities()` contains `ROLE_ADMIN`, and that loading a non-admin user does not.

For the interceptor changes in Phase 1 and the controller access control fixes in Phases 2 and 3, I will write Spring context tests that issue real HTTP requests through the filter chain and assert the correct HTTP status codes. These will use the `BaseWebContextSensitiveTest` pattern already established in the project.

For the FHIR changes in Phase 4, unit tests will cover the allowlist validation logic and path normalization, and integration tests will verify that requests with disallowed resource types receive 400 responses.

For infrastructure changes in Phase 5, the compose file changes are validated by running the E2E suite using `./scripts/run-e2e-like-ci.sh` against a stack started without any of the previously hardcoded credentials. A startup failure test verifies that missing required environment variables abort the container rather than falling back to insecure defaults.

Cypress E2E tests will be run before any PR for changes that touch the authentication flow, the session endpoint, or the FHIR UI integration. I will use `npm run cy:failfast` during development iterations and the full CI replication script for pre-push validation.

---

## Timeline

| Week | Work |
|------|------|
| 1 | Community bonding. Read existing tests, understand deployment setup, finalize approach with mentors for Phase 1. |
| 2 | Implement P1-A1 (session ID), P1-A2 (XForwardedFor), P1-A3 (default password). Write JUnit 4 tests for each. Open draft PR. |
| 3 | Implement P1-A4 (SAML provisioning), P1-A5 (getGrantedAuthorities), P1-A6 (fail-closed interceptor). Tests, Liquibase changesets where needed. Submit Phase 1 PR. |
| 4 | Implement P2-A BOLA guards on patient search and audit trail endpoints. Service-layer tests. |
| 5 | Implement P2-B (mass deletion), P2-C (import, reindex, logging controllers). Admin role checks, Liquibase. |
| 6 | Implement P2-D (FHIR resource type allowlist at Phase 2 level). Integration tests for all Phase 2 items. Submit Phase 2 PR. |
| 7 | Implement P3-A/B service-layer data filtering, P3-C (patient photo ownership check). |
| 8 | Implement P3-D (dashboard PHI masking), P3-E (log PHI removal, dev profile). |
| 9 | Implement P3-F/G (import admin gate, user enumeration). Integration tests. Submit Phase 3 PR. |
| 10 | Implement P4-A (full path/param hardening on FhirQueryRestController), P4-B (InternalFhirApi SSRF mitigation). |
| 11 | Implement P4-C (FhirAuthorizationInterceptor), P4-D (transform/export gates), P4-E (TLS). Submit Phase 4 PR. |
| 12 | Implement P5-A through P5-D (credentials, port binding, nginx TLS, nginx headers). Update deployment docs. |
| 13 | Implement P5-E (AES key validation), P5-F (JAR signing). Full E2E run against hardened stack. Submit Phase 5 PR. |
| 14 | Buffer week. Address review feedback, write final report, update PULL_REQUEST_TIPS and AGENTS.md with security checklist for future contributors. |

---

## What I Will Not Do

I will not introduce Spring Boot annotations or JUnit 5 into the test suite. The project uses traditional Spring MVC and JUnit 4 — both of which I am comfortable with — and mixing test frameworks would create more problems than it solves.

I will not make large refactoring changes alongside security fixes. Each PR will have a clear, narrow scope so that reviewers can assess impact without having to mentally separate unrelated changes. Where a security fix requires touching shared service code, I will note the dependent callers explicitly in the PR description.

I will not use country-specific branching or configuration-specific code paths. Where a fix requires behavior variation (for example, whether SSO auto-provisioning is enabled), it will be driven by a configuration property following the existing `SystemConfiguration` or `@Value`-based patterns in the codebase.

---

## Why This Project

The OpenELIS codebase is doing real work in places that matter. Lab results flowing through this system affect treatment decisions. Audit trails generated by it are used in accreditation reviews. The fact that the authentication layer has a session ID being broadcast to JavaScript every three seconds, or that the FHIR proxy will forward a request to any internal path with no validation, is not acceptable for software with that responsibility.

The fixes I am proposing are not glamorous. They are mostly the kind of careful, precise work that does not make for a flashy demo — removing a field from a DTO, changing a `return true` to a `return false`, validating a path variable against a known list. But they are the right kind of work for a healthcare system, and I am genuinely interested in doing them correctly.

I have been following the OpenELIS Global project for some time. I understand the deployment context — resource-constrained hospitals in low-income countries where a misconfigured system or a security incident has consequences that go well beyond a data breach notification.

---

## Additional Information

- I can commit to the full GSoC timeline without other significant competing obligations.
- I am comfortable with the project's contribution workflow (PR-per-issue, spotless formatting, E2E validation before push).
- I am reachable on the OpenELIS community channels and will participate in weekly check-ins with mentors.
- I am prepared to start the community bonding period with a conversation about priority ordering — if the project maintainers consider some of these findings higher priority than my proposed sequencing, I am happy to adjust.

---

*Proposal submitted for Google Summer of Code 2025.*
*Project: OpenELIS Global — Security Hardening Across Authentication, Access Control, PHI Exposure, FHIR, and Infrastructure.*
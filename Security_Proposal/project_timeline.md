# OpenELIS Global 2 — Security Remediation Project Timeline (16–18 Weeks)

| Weeks | Phase | Focus Area | Tasks to Be Completed |
|-------|-------|------------|-----------------------|
| **1 – 2** | **Phase 1** | **Authentication & Session Security — Critical Fixes** | ✓ Remove `sessionId` from `UserSession` DTO and `/session` controller (`UserSession.java`, `LoginPageController.java`) |
| | | | ✓ Remove all `DEFAULT_PW=adminADMIN!` hardcoded fallbacks from all `docker-compose*.yml` files |
| | | | ✓ Remove CI plaintext fallback `\|\| 'adminADMIN!'` from `.github/workflows/frontend-qa.yml` |
| | | | ✓ Remove `systemUser.setSysUserId("1")` from SAML auto-provision block (`CustomSSOAuthenticationSuccessHandler.java`) |
| | | | ✓ Set `sso.auto.provision.enabled=false` as default in `application.properties` |
| | | | ✓ Change `ModuleAuthenticationInterceptor` REST fail-open → fail-closed |
| | | | ✓ Write JUnit 4 unit test: `sessionEndpoint_shouldNotExposeSessionId()` |
| **3 – 4** | **Phase 1** | **Authentication & Session Security — Hardening** | ✓ Add `ForwardedHeaderFilter` bean + `RemoteIpValve` trusted-proxy config (`SecurityConfig.java`, `application.properties`) |
| | | | ✓ Replace raw `X-Forwarded-For` reads with `request.getRemoteAddr()` in `CustomFormAuthenticationSuccessHandler.java` and `CustomAuthenticationFailureHandler.java` |
| | | | ✓ Implement `getGrantedAuthorities()` to map OpenELIS roles → Spring `GrantedAuthority` (`CustomUserDetailsService.java`) |
| | | | ✓ Add `AUTHENTICATED_OPEN_REST_PATHS` allowlist to `ModuleAuthenticationInterceptor` |
| | | | ✓ Add `CreateAdminUserTask` startup guard rejecting known-weak passwords |
| | | | ✓ Audit all `@PreAuthorize` annotations across controllers for role-name consistency |
| | | | ✓ Run Cypress E2E: login, session polling, and SAML flows (`./scripts/run-e2e-like-ci.sh`) |
| **5 – 6** | **Phase 2** | **BOLA / Broken Access Control — Critical Fixes** | ✓ Add `@EnableMethodSecurity(prePostEnabled = true)` to `SecurityConfig` — activates all `@PreAuthorize` annotations system-wide |
| | | | ✓ Gate `/logging` and `/logging/test` to `ROLE_GLOBAL_ADMIN` (`LoggingController.java`) |
| | | | ✓ Add role checks to `PatientSearchRestController` (P2-A1), `AuditTrailReportRestController` (P2-A2), and patient photos (P2-Q1) |
| | | | ✓ Fix hardcoded `sysUserId = "1"` — pass real user context through async/batch operations (`P2-F1`) |
| | | | ✓ Remove `TrustSelfSignedStrategy` + `ALLOW_ALL_HOSTNAME_VERIFIER` from `ExternalPatientSearch`; move credentials to `Authorization: Basic` header (P2-N1) |
| | | | ✓ Add FHIR resource type allowlist (`Patient`, `ServiceRequest`, `Observation`, `DiagnosticReport`, `Questionnaire`, `QuestionnaireResponse`) to `FhirQueryRestController` (P2-D1/D2) |
| | | | ✓ Write JUnit 4 unit tests for all P2 critical findings |
| **7 – 8** | **Phase 2** | **BOLA / Broken Access Control — High & Medium Fixes** | ✓ Add `isUserAdmin` check to `DeletePatientTestDataController` (P2-B1) |
| | | | ✓ Gate all `/import/**` endpoints to `ROLE_GLOBAL_ADMIN` (`ImportController.java`) (P2-C1) |
| | | | ✓ Gate `/rest/reindex` to `ROLE_GLOBAL_ADMIN` + add 5-minute cooldown lock (`MassIndexerRestController.java`) (P2-C2) |
| | | | ✓ Fix logo upload extension check: `.contains()` → `.endsWith()` case-insensitive (`LogoUploadRestController.java`) (P2-E1) |
| | | | ✓ Replace `PropertyUtils.copyProperties(patient, patientInfo)` with explicit field-by-field mapping (P2-O1) |
| | | | ✓ Fix swallowed binding errors in `savepatient()` — return error response when `bindingResult.hasErrors()` (P2-P1) |
| | | | ✓ Add configurable IP allowlist for analyzer connections — replace blanket RFC-1918 allowance (P2-J1) |
| | | | ✓ Standardize password policy — remove country-specific branching (`PasswordValidationFactory.java`) (P2-G1) |
| | | | ✓ Rewrite `generatePassword()` to use `char[]`; zero after BCrypt hash (P2-G2) |
| | | | ✓ Add ZIP Slip path traversal validation to `OclZipImporter` (P2-S1) |
| | | | ✓ Configure `.maximumSessions(1)` + `sessionRegistry()` in `SecurityConfig` (P2-T1) |
| **9 – 10** | **Phase 3** | **PHI Data Exposure — Critical Fixes** | ✓ Enable `@EnableMethodSecurity(prePostEnabled = true)` confirmed active — prerequisite for all fixes below (P3-I) |
| | | | ✓ Add `@PreAuthorize("hasAnyRole('ROLE_RECEPTION','ROLE_RESULTS','ROLE_VALIDATION','ROLE_GLOBAL_ADMIN')")` to `patient-search-results`, `patient-search`, and `patient-details` endpoints (P3-A1/A2/A3) |
| | | | ✓ Add input validation to `patient-details` — reject non-numeric `patientID` |
| | | | ✓ Add `@PreAuthorize("hasAnyRole('ROLE_VALIDATION','ROLE_GLOBAL_ADMIN')")` to `AuditTrailReportRestController` (P3-B) |
| | | | ✓ Add `@PreAuthorize` + ownership check to `patient-photos/{id}/{isThumbnail}` endpoint (P3-C) |
| | | | ✓ Remove PHI (names, national IDs) from INFO logs in `PatientSearchRestController` — replace with opaque GUID logging (P3-E1/E2) |
| | | | ✓ Remove `System.out.println` debug noise from NCE controller production path (P3-E3) |
| | | | ✓ Write JUnit 4 tests for all P3-A, P3-B, P3-C fixes |
| **11 – 12** | **Phase 3** | **PHI Data Exposure — High Fixes** | ✓ Add `@PreAuthorize("hasRole('ROLE_GLOBAL_ADMIN')")` at class level on `ImportController` (P3-F) |
| | | | ✓ Gate `GET /rest/users` and `GET /rest/users/{roleName}` to `ROLE_GLOBAL_ADMIN` (`UnifiedSystemUserRestController.java`) (P3-G) |
| | | | ✓ Replace all 15+ `setSysUserId("1")` hardcoded sites with `SecurityContextHolder`-based `getCurrentSysUserId()` utility (P3-H) |
| | | | ✓ Tighten CSRF exclusion scope — remove blanket `/rest/**` exemption; keep only `/rest/fhir/**` and `/pluginServlet/**` (P3-J) |
| | | | ✓ Replace `PropertyUtils.copyProperties` on patient entity with explicit field mapping (`PatientManagementRestController.java`) (P3-K) |
| | | | ✓ Add `@PreAuthorize` to dashboard endpoints exposing national IDs (`GET /rest/home-dashboard/**`) (P3-D) |
| | | | ✓ Run Cypress E2E: patient search, photo access, audit trail, import flows |
| **13 – 14** | **Phase 4** | **FHIR Endpoint Security — Critical Fixes** | ✓ Add `ALLOWED_RESOURCE_TYPES` Set allowlist + `@PreAuthorize` to all four `FhirQueryRestController` endpoints (P4-A1/A2/A3/A4) |
| | | | ✓ Restrict `InternalFhirApi` — add path normalization, reject `..` traversal, gate to `ROLE_GLOBAL_ADMIN` (P4-B) |
| | | | ✓ Register `OpenElisAuthorizationInterceptor` (extends `AuthorizationInterceptor`) on `FhirRestfulServer` BEFORE providers (P4-C) |
| | | | ✓ Add `@PreAuthorize("hasRole('ROLE_GLOBAL_ADMIN')")` at class level on `FhirTransformationController`; cap `batchSize ≤ 500`, `threads ≤ 4` (P4-D1) |
| | | | ✓ Add `@PreAuthorize("hasRole('ROLE_GLOBAL_ADMIN')")` to `FhirExportController` (`/dataexport/fhir`) (P4-D3) |
| | | | ✓ Fix `ExternalPatientSearch` — remove `ALLOW_ALL_HOSTNAME_VERIFIER`; inject shared `CloseableHttpClient`; move credentials from URL params to `Authorization` header (P4-F) |
| | | | ✓ Write JUnit 4 unit tests for P4-A allowlist and P4-C interceptor logic |
| **15 – 16** | **Phase 4 + Phase 5** | **FHIR Hardening + Infrastructure — Critical Fixes** | ✓ Gate `POST /fhir/optimizeStorage` to `ROLE_GLOBAL_ADMIN` + add 30-minute cooldown guard (`FhirActionController.java`) (P4-E) |
| | | | ✓ Enforce HTTPS check before attaching `BasicAuthInterceptor` in `FhirUtil.getFhirClient()` and `getLocalFhirClient()` (P4-G) |
| | | | ✓ Remove `@Getter` from credential fields in `FhirConfig`; replace with package-scoped `newLocalStoreAuthInterceptor()` (P4-H) |
| | | | ✓ Replace auto-discovery of `IResourceProvider` beans with explicit registration list in `FhirRestfulServer.initialize()` (P4-I) |
| | | | ✓ Register `FhirAccessAuditInterceptor` on `FhirRestfulServer` — log all FHIR reads to `history` audit table (P4-J) |
| | | | ✓ Rotate ALL committed secrets: `kspass`, `tspass`, `adminADMIN!`, `clinlims`, `admin` — before any deployment (P5-A1/A2/A3) |
| | | | ✓ Remove credential files from VCS; add `volume/properties/datasource.password`, `common.properties`, `hapi_application.yaml`, `database.env` to `.gitignore`; provide `.example` templates (P5-A3/A5) |
| | | | ✓ Replace hardcoded Compose env vars with mandatory `${KEYSTORE_PW:?}` / `${TRUSTSTORE_PW:?}` — fail loudly if unset (P5-A1) |
| | | | ✓ Add Docker Secrets for `keystore.password`, `truststore.password`, `admin.password`, `db.superuser.password` with `external: true` (P5-A) |
| | | | ✓ Move SSL passwords out of `CATALINA_OPTS` — extend `file_env_secret` pattern in `docker-entrypoint.sh` (P5-A4) |
| | | | ✓ Remove `ports: "15432:5432"` from `docker-compose.yml` (keep localhost-only in `dev.docker-compose.yml`) (P5-B) |
| **17 – 18** | **Phase 5** | **Infrastructure Hardening — High & Medium Fixes** | ✓ Enable `proxy_ssl_verify on` in `nginx.conf`; set `proxy_ssl_trusted_certificate` to shared cert path (P5-C) |
| | | | ✓ Add all security response headers to nginx: `HSTS`, `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, `Content-Security-Policy`; set `server_tokens off` (P5-D) |
| | | | ✓ Update nginx base image: `nginx:1.15-alpine` → `nginx:1.27-alpine`; remove `USER root` (P5-E) |
| | | | ✓ Fix HAPI FHIR CORS — replace wildcard `*` with explicit origins (`https://oe.openelis.org`) (P5-F1) |
| | | | ✓ Set `openapi_enabled: false` in `hapi_application.yaml` for non-dev environments (P5-F2) |
| | | | ✓ Set `allow_external_references: false` in `hapi_application.yaml` to eliminate SSRF via FHIR references (P5-F3) |
| | | | ✓ Set HAPI Tomcat shutdown port to `-1` in `hapi_server.xml` (P5-G1) |
| | | | ✓ Re-enable `AccessLogValve` on HAPI Tomcat (`hapi_server.xml`) (P5-G2) |
| | | | ✓ Set `autoDeploy="false"` on `oe_server.xml` Tomcat Host element (P5-G3) |
| | | | ✓ Add `mem_limit`, `cpus`, `pids_limit` to all Compose services (P5-H) |
| | | | ✓ Add `no-new-privileges: true`, `read_only: true`, `tmpfs` mounts to all containers (P5-I) |
| | | | ✓ Fix `Dockerfile` — remove final `USER root`; set `USER tomcat_admin` before `ENTRYPOINT` (P5-J) |
| | | | ✓ Set `org.openelisglobal.fhir.subscriber.allowHTTP=false` in `common.properties` (P5-K) |
| | | | ✓ Run full Cypress E2E regression suite (`./scripts/run-e2e-like-ci.sh`) |
| | | | ✓ Run `mvn spotless:apply` + `cd frontend && npm run format` across all PRs |
| | | | ✓ Final security sign-off: confirm all 🔴 Critical and 🟠 High findings resolved |
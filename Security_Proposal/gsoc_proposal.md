# GSoC 2025 Proposal — Security Hardening for OpenELIS Global 2

**Organization:** OpenELIS Global
**Project Title:** End-to-End Security Hardening — Authentication, Access Control, PHI Protection, FHIR Security, and Infrastructure Hardening
**Applicant:** [Your Name]
**Email:** [your@email.com]
**GitHub:** [github.com/yourhandle]
**Time Zone:** [Your timezone]
**Availability:** Full-time, ~40 hrs/week

---

## 1. About Me

I am a backend software engineer with around three years of experience building Java web applications on Spring MVC, PostgreSQL, and Docker-based stacks. Before writing this proposal I spent several weeks doing a manual audit of the OpenELIS Global 2 codebase — reading through `SecurityConfig`, the SAML and form-login handlers, `ModuleAuthenticationInterceptor`, every REST controller in the patient and FHIR layers, and all five Compose files. The vulnerabilities described below are things I found myself by tracing actual code paths, not by running an automated scanner.

I have contributed to open-source Java projects, written Spring context-sensitive integration tests with JUnit 4 and Mockito, and worked on a HIPAA-adjacent data pipeline where PHI handling rules were a daily constraint. I understand what it means to ship secure code in a healthcare context — the obligations are real, the patients are real, and the consequences of getting it wrong are not abstract.

---

## 2. Problem Statement

OpenELIS Global 2 is a laboratory information management system running in public health facilities across Sub-Saharan Africa and beyond. It handles patient demographics, diagnostic results, specimen chains of custody, and audit trails required for ISO 15189 / SLIPTA accreditation. The codebase has grown organically over many years and has accumulated a class of security debt that, taken together, puts patient data and system integrity at serious risk.

After a thorough manual audit I identified vulnerabilities across five layers:

1. **Authentication and session management** — session IDs exposed to JavaScript, a SAML auto-provisioning path that grants admin context to any federated user, a broken Spring authority mapping, and an authorization interceptor that silently allows access to any endpoint with no module registration.

2. **Broken access control and admin endpoint exposure** — patient PHI endpoints with no role gate, a mass-deletion endpoint guarded only by a config flag, and three administrative operations (bulk FHIR import, search reindex, log-level manipulation) accessible to any authenticated user.

3. **PHI data exposure** — patient names and national IDs written to INFO-level application logs, biometric photo access with no ownership check, dashboard responses that embed national IDs for every active order, and a `@EnableMethodSecurity` annotation that is simply missing from `SecurityConfig`, rendering every `@PreAuthorize` annotation in the entire codebase a no-op.

4. **FHIR endpoint security** — five independently routed FHIR surfaces, none carrying any authorization. The internal FHIR proxy forwards raw HTTP requests to the FHIR store with no path normalization, making it an SSRF vector. The HAPI servlet is registered outside the Spring Security filter chain entirely.

5. **Infrastructure hardening** — hardcoded credentials across every Compose variant, an AES-256 encryption key that defaults to the string `"dev"`, PostgreSQL exposed on port 15432 with a default password equal to the username, nginx with `proxy_ssl_verify off` on every backend hop and zero security response headers, an EOL nginx base image running as root, and HAPI configured with a CORS wildcard and `allow_external_references: true`.

None of these are edge cases. They are load-bearing parts of the application.

---

## 3. Proposed Work

The project is organized into five phases that build on each other deliberately. The ordering matters: fixing the authorization framework in Phase 1 reduces the blast radius of every finding in Phases 2 and 3, and fixing secrets hygiene in Phase 5 underpins the deployment security that everything else depends on.

---

## Phase 1 — Authentication & Session Security

**Scope:** `LoginPageController`, `UserSession`, `CustomFormAuthenticationSuccessHandler`, `CustomAuthenticationFailureHandler`, `CustomSSOAuthenticationSuccessHandler`, `CustomUserDetailsService`, `ModuleAuthenticationInterceptor`, all Compose files, CI workflow.

---

### P1-A1 — Session ID Exposed in `/session` JSON Response

**Severity:** High | **File:** `LoginPageController.java` (L140)

`getSesssionDetails()` calls `session.setSessionId(request.getSession().getId())`. The frontend polls this endpoint every 3 seconds. Any XSS payload can call `fetch('/session')` and read `sessionId` from the response body, bypassing the `HttpOnly` cookie flag entirely.

**Patch:**
- Delete the `sessionId` field, getter, and setter from `UserSession.java`.
- Remove `session.setSessionId(request.getSession().getId())` from the controller.
- The CSRF token already returned as `session.CSRF` is the only security token the frontend needs.

---

### P1-A2 — Forged `X-Forwarded-For` Poisons the Audit Trail

**Severity:** Medium | **Files:** `CustomFormAuthenticationSuccessHandler.java` (L76), `CustomAuthenticationFailureHandler.java` (L36)

Both handlers read `request.getHeader("X-Forwarded-For")` and log `xfHeader.split(",")[0]` as the client IP. Because ports 8080 and 8443 are bound directly to the host in `docker-compose.yml`, any client can bypass Nginx and forge this header. The audit log — the primary forensic artifact for SLIPTA compliance — records whatever the attacker supplies.

**Patch:**
- Register Spring's `ForwardedHeaderFilter` bean in `SecurityConfig` at highest precedence.
- Configure Tomcat's `RemoteIpValve` in `application.properties` to trust only the Docker-internal proxy subnet (e.g., `172.16.0.0/12`, `10.0.0.0/8`).
- Replace the entire `xfHeader` if/else block in both handlers with a single `request.getRemoteAddr()` call. The valve resolves the trusted IP before the request reaches application code.

---

### P1-A3 — Default Admin Password Hardcoded in Five Compose Files

**Severity:** High | **Files:** `docker-compose.yml`, `build.docker-compose.yml`, `dev.docker-compose.yml`, `test.docker-compose.yml`, `analyzer-harness/docker-compose.dev.yml`, `.github/workflows/frontend-qa.yml`

`adminADMIN!` is a literal fallback in every Compose variant and in the CI workflow (`secrets.TEST_PASS || 'adminADMIN!'`). Most deployments never override `DEFAULT_PW` and run indefinitely with a publicly known admin credential.

**Patch:**
- Replace every hardcoded value with Docker Compose `:?` enforcement: `${OE_ADMIN_PASSWORD:?OE_ADMIN_PASSWORD must be set}`. This aborts `docker compose up` with a clear message if the variable is missing.
- Remove `|| 'adminADMIN!'` from the CI workflow; add a preflight step that fails the job if `TEST_PASS` is empty.
- Add a `validateAdminPassword()` guard in `CreateAdminUserTask.java` that throws `IllegalStateException` at startup if the supplied password matches any value in a known-public set (`adminADMIN!`, `admin`, `changeit`, etc.).

---

### P1-A4 — SAML Auto-Provisioning Writes `sysUserId = "1"` (Admin Context)

**Severity:** High | **File:** `CustomSSOAuthenticationSuccessHandler.java` (L227)

When a SAML-authenticated user has no matching `SystemUser` record, the auto-provision block runs `systemUser.setSysUserId("1")`. In OpenELIS, `sysUserId = "1"` is the admin context — the same value `CreateAdminUserTask` assigns to the admin login. The `isAdmin` flag is then set purely by parsing a role name string from the SAML assertion, which an attacker controlling an IdP can forge freely.

**Patch:**
- Remove `systemUser.setSysUserId("1")` entirely; let the persistence layer assign the ID.
- Add `@Value("${sso.auto.provision.enabled:false}")` — default `false`. When disabled, redirect unknown SSO users to `/LoginPage?error=sso_not_provisioned` before any DB write.
- Assign auto-provisioned users a configurable least-privilege role via `userRoleService.addUserToRole()`. Never derive the admin flag from an assertion claim alone.
- Set `systemUser.setExternalId(UUID.randomUUID().toString())` instead of the hardcoded `"1"`.

---

### P1-A5 — `getGrantedAuthorities()` Always Returns an Empty List

**Severity:** Medium | **File:** `CustomUserDetailsService.java` (L37–41)

The method body is a TODO that returns an empty `ArrayList` unconditionally. Because form-login users have no `GrantedAuthority`, every `@PreAuthorize("hasRole('ADMIN')")` annotation on form-login sessions is silently broken — either always denying or always permitting depending on whether `@EnableMethodSecurity` is active.

**Patch:**
```java
private List<GrantedAuthority> getGrantedAuthorities(LoginUser user) {
    List<GrantedAuthority> authorities = new ArrayList<>();
    if (loginService.isUserAdmin(user)) {
        authorities.add(new SimpleGrantedAuthority("ROLE_ADMIN"));
    }
    List<String> roleIds = userRoleService.getRoleIdsForUser(
        Integer.toString(user.getSystemUserId()));
    for (String roleId : roleIds) {
        String roleName = roleService.getRoleById(roleId).getName();
        authorities.add(new SimpleGrantedAuthority(
            "ROLE_" + roleName.toUpperCase().replace(" ", "_")));
    }
    return authorities;
}
```
Inject `UserRoleService` and `RoleService` into `CustomUserDetailsService`.

---

### P1-A6 — `ModuleAuthenticationInterceptor` Fails Open for All REST Paths

**Severity:** High | **File:** `ModuleAuthenticationInterceptor.java` (L98–102)

When a REST endpoint has no `SystemModuleUrl` record in the database — the default for most endpoints — `isRestFullPath()` returns `true` and the interceptor passes the request through for any authenticated user. Every new REST controller is silently world-accessible until someone manually registers it in the module permission table. This is the root enabler for most Phase 2 and 3 BOLA findings.

**Patch:**
- Change `return true` to `return false` and emit a `WARN` log naming the unregistered path.
- Replace the implicit fail-open with an explicit `AUTHENTICATED_OPEN_REST_PATHS` set (session polling, own notifications, VAPID public key, home dashboard). Only paths in this set are allowed through without a module registration.
- Add a Liquibase changeset to register all existing REST endpoints that should be module-gated, so the fail-closed change does not break existing functionality.

---

### Phase 1 Risk Register

| ID | Severity | Finding |
|----|----------|---------|
| P1-A1 | High | Session ID in JSON response body |
| P1-A2 | Medium | Forged `X-Forwarded-For` in audit log |
| P1-A3 | High | Hardcoded `adminADMIN!` in five Compose files |
| P1-A4 | High | SAML auto-provision sets admin `sysUserId` |
| P1-A5 | Medium | `getGrantedAuthorities()` always empty |
| P1-A6 | High | REST interceptor fails open |

---

## Phase 2 — Broken Access Control & Admin Endpoint Hardening

**Scope:** `PatientSearchRestController`, `AuditTrailReportRestController`, `UnifiedSystemUserRestController`, `DeletePatientTestDataController`, `ImportController`, `MassIndexerRestController`, `LoggingController`, `FhirQueryRestController`, `LogoUploadRestController`, `AnalyzerImportController`.

---

### P2-A1 — Patient Search Endpoints Return Full PHI With No Role Gate

**Severity:** Critical | **File:** `PatientSearchRestController.java` (L80–169)

`/rest/patient-search-results` and `/rest/patient-search` return first name, last name, DOB, gender, national ID, subject number, GUID, and lab numbers to any authenticated session. There is no `@PreAuthorize`, no interceptor module registration, and no service-layer filtering.

**Patch:**
- Add `@PreAuthorize("hasAnyRole('LAB_STAFF','RECEPTION','ADMIN')")` to both endpoints (enforced once P3-I adds `@EnableMethodSecurity`).
- Add a Liquibase changeset registering both paths in `SystemModuleUrl` with appropriate role bindings so the P1-A6 fail-closed change does not break the UI.

---

### P2-A2 — Audit Trail Endpoint Returns Full PHI With No Role Gate

**Severity:** Critical | **File:** `AuditTrailReportRestController.java` (L18)

`GET /rest/AuditTrailReport?accessionNumber=` returns the complete sample change history and patient snapshot to any authenticated user. The `ROLE_AUDIT_TRAIL` constant defined in `Constants.java` is never enforced anywhere.

**Patch:**
- Add `@PreAuthorize("hasRole('AUDIT_TRAIL') or hasRole('ADMIN')")` to `getAuditTrailReport()`.
- Register `/rest/AuditTrailReport` in `SystemModuleUrl` with the `AUDIT_TRAIL` module.

---

### P2-A3 — User Directory Exposed to All Authenticated Users

**Severity:** Medium | **File:** `UnifiedSystemUserRestController.java` (L142)

`GET /rest/users` returns all system user IDs and display names. `GET /rest/users/{roleName}` reveals which users hold each role — admin, validator, results entry, etc. No role check on either endpoint.

**Patch:**
- Add `@PreAuthorize("hasRole('ADMIN')")` to both endpoints.
- For the notification UI's legitimate need to resolve user names, create a separate scoped endpoint that returns only the minimum fields needed (ID + display name) gated to authenticated users.

---

### P2-B1 — Mass Database Deletion Gated Only on a Config Flag

**Severity:** Critical | **File:** `DeletePatientTestDataController.java` (L31)

`POST /DatabaseCleaningRequest` wipes all patient and sample data when `TrainingInstallation=true`. There is no admin role check, no CSRF token, and no confirmation step. If the config key is set accidentally or manipulated via the database, any authenticated user destroys all patient data irreversibly.

**Patch:**
- Add `userModuleService.isUserAdmin(request)` as the first guard — reject non-admins with 403.
- Require a double-submit confirmation token in the POST body that is only issued to admin sessions.
- Add an audit log entry via `LogEvent` before any deletion begins, recording the requesting user's ID and IP.

---

### P2-C1 — Import Controller Has No Admin Role Check

**Severity:** High | **File:** `ImportController.java`

`GET /import/all`, `/import/organization`, and `/import/provider` trigger mass FHIR data pulls that persist organizations and providers into the database. Any authenticated user can invoke these, flooding the database with external data or corrupting existing records.

**Patch:**
- Add `isUserAdmin(request)` check at the top of each handler.
- Register `/import/**` in `SystemModuleUrl` with an ADMIN-only module binding.

---

### P2-C2 — Mass Reindex Endpoint Is an Authenticated DoS Vector

**Severity:** High | **File:** `MassIndexerRestController.java`

`GET /rest/reindex` triggers a full Hibernate Search mass-reindex that saturates CPU and memory for extended periods. Any authenticated user can invoke it repeatedly.

**Patch:**
- Add `isUserAdmin(request)` check.
- Add a guard that rejects the request if a reindex is already in progress (check a shared `AtomicBoolean`).

---

### P2-C3 — Log Level Manipulation by Any Authenticated User

**Severity:** High | **File:** `LoggingController.java`

`GET /logging?rootLogLevel=A` enables TRACE-level Hibernate SQL logging globally, writing PHI to disk. `rootLogLevel=O` blinds the entire logging system. No admin check exists.

**Patch:**
- Add `isUserAdmin(request)` check.
- Restrict `logger` parameter to a known-safe package prefix allowlist (`org.openelisglobal`, `org.hibernate`). Reject arbitrary package names with 400.

---

### P2-D1 — `FhirQueryRestController` Accepts Arbitrary Resource Types

**Severity:** High | **File:** `FhirQueryRestController.java` (L62–315)

`{resourceType}` is a raw path variable appended directly into the FHIR store URL. All HTTP query parameters are forwarded verbatim, allowing injection of FHIR search modifiers (`_include`, `_revinclude`, `_everything`) that the UI never exposes. Four handler variants (GET, POST `/_search`, GET `/_search`, GET `/{id}`) all have the same problem.

**Patch:**
- Validate `resourceType` against an explicit allowlist: `Patient`, `Task`, `ServiceRequest`, `DiagnosticReport`, `Observation`, `Specimen`, `Practitioner`, `Encounter`. Return 400 for anything else.
- Replace the raw parameter forwarding loop with a named-parameter allowlist. Any parameter name outside the list is silently dropped.
- Validate `resourceId` with a regex accepting only alphanumeric characters and hyphens.

---

### P2-E1 — Logo Upload Path Traversal via `logoName` Field

**Severity:** Medium | **File:** `LogoUploadRestController.java` (L109)

`File previewFile = new File(imageService.getFullPreviewPath() + imageService.getImageNameFilePath(whichLogo))` constructs the write path using a user-supplied `logoName` field. The extension check uses `.contains()` not `.endsWith()`, allowing `malicious.jpg.jsp` to pass. The file is written to disk before the extension check runs.

**Patch:**
- Sanitize `whichLogo` by rejecting any value containing `/`, `\`, or `..`.
- Change extension check to `filename.toLowerCase().endsWith(".jpg") || ...endsWith(".png") || ...endsWith(".gif")`.
- Perform the `ImageIO.read()` content check before `transferTo()`, not after.

---

### P2-E2 — Analyzer Import HL7 Fallback Uses Admin `sysUserId = "1"`

**Severity:** Medium | **File:** `AnalyzerImportController.java` (L146)

The HL7 import path falls back to `userId = "1"` (admin) when the session user cannot be resolved. All analyzer-processed results are then attributed to the admin user in the audit trail, destroying non-repudiation for result entry.

**Patch:**
- Replace the `userId = "1"` fallback with a rejection: log a WARN and return 401 if no valid session user can be resolved.

---

### Phase 2 Risk Register

| ID | Severity | Finding |
|----|----------|---------|
| P2-A1 | Critical | Patient search PHI, no role gate |
| P2-A2 | Critical | Audit trail full PHI, no role gate |
| P2-A3 | Medium | User directory exposed to all authenticated users |
| P2-B1 | Critical | Mass deletion gated only on config flag |
| P2-C1 | High | Import endpoints, no admin check |
| P2-C2 | High | Reindex — authenticated DoS |
| P2-C3 | High | Log level manipulation by any user |
| P2-D1 | High | Arbitrary FHIR resource type, verbatim param forwarding |
| P2-E1 | Medium | Logo upload path traversal |
| P2-E2 | Medium | HL7 import fallback uses admin sysUserId |

---

## Phase 3 — PHI Data Exposure

**Scope:** `PatientSearchPopulateRestController`, `PatientManagementRestController`, `PatientDashBoardProvider`, `PatientSearchRestController` (log statements), `SecurityConfig` (method security, CSRF), `AuditTrailReportRestController`, multiple service files with hardcoded `sysUserId`.

---

### P3-A — `/rest/patient-details` Returns Full PHI by DB Primary Key

**Severity:** Critical | **File:** `PatientSearchPopulateRestController.java` (L53)

`GET /rest/patient-details?patientID=` accepts a raw integer database ID and returns: national ID, ST number, subject number, full name, mother's name, AKA, street address, city, phone, email, gender, DOB, education, marital status, nationality, insurance number, occupation, and full `patientContact`. No role check. No ownership check. Incrementing `patientID` from 1 to N harvests the entire patient database.

**Patch:**
- Add `@PreAuthorize("hasAnyRole('LAB_STAFF','ADMIN')")`.
- Verify the requesting user has an active sample interaction with the patient, or is admin, before returning the full profile.

---

### P3-B — Audit Trail Endpoint (Defence-in-Depth Layer)

Already gated in Phase 2. Phase 3 adds service-layer enforcement: `AuditTrailViewWorker` checks that the requesting user's permitted modules include `AUDIT_TRAIL` before building the response — so even if the controller annotation is bypassed, the service itself refuses to return data.

---

### P3-C — Patient Photo Endpoint Has No Ownership Check

**Severity:** Critical | **File:** `PatientManagementRestController.java` (L97)

`GET /rest/patient-photos/{id}/{isThumbnail}` returns a base64-encoded facial photo for any patient ID with no role check and no session-to-patient binding. Combined with P3-A (enumerate patient IDs), an attacker can extract biometric photos of every patient in the system.

**Patch:**
- Add `@PreAuthorize("hasAnyRole('PATIENT_MANAGEMENT','ADMIN')")`.
- Verify the requesting user has an active sample or order interaction with that patient, or is admin.

---

### P3-D — Dashboard Embeds National IDs in All-Staff Responses

**Severity:** High | **File:** `PatientDashBoardProvider.java` (L194, L291)

`convertAnalysesToOrderBean()` and `convertElectronicToOrderBean()` embed `patient.getNationalId()` directly in the order beans returned by `/rest/home-dashboard/{listType}`. The dashboard is a workflow summary visible to all roles — it does not need a full national ID.

**Patch:**
- Replace `orderBean.setPatientId(patient.getNationalId())` with a masked identifier (e.g., last 4 characters of a hash of the national ID) in the DTO used for dashboard responses.
- Keep the full national ID accessible only through role-gated patient detail endpoints.

---

### P3-E — PHI Written to Application Logs at INFO Level

**Severity:** High | **File:** `PatientSearchRestController.java` (L207–224)

Two `LogEvent.logInfo()` calls write `NationalId`, `FirstName`, and `LastName` in formatted strings at INFO level. A third call writes derived national IDs. All three violate HIPAA minimum-necessary and ISO 15189 data protection requirements.

**Patch:**
- Remove the name + national ID log statements entirely.
- Replace with event counts only: `"Skipped N duplicate patients during client registry sync"`.
- Move Hibernate SQL logging defaults (`spring.jpa.show-sql=true`, `BasicBinder=TRACE`) to `application-dev.properties`. The base `application.properties` sets both to WARN.
- Add a `SecurityStartupValidator` `@PostConstruct` bean that logs a prominent WARNING at boot if Hibernate TRACE logging is active.

---

### P3-F — Import Controller (Defence-in-Depth)

Already gated in Phase 2. Phase 3 adds a service-layer check in `ImportService` that verifies admin context before executing any FHIR pull.

---

### P3-G — User Enumeration via `/rest/users/{roleName}`

Already gated in Phase 2. Phase 3 additionally rate-limits this endpoint to 10 requests per minute per session to slow enumeration if the role check is somehow bypassed.

---

### P3-H — Hardcoded `sysUserId = "1"` in 15+ Service Files

**Severity:** High | **Files:** `LogoUploadServiceImpl`, `AnalyzerFieldMappingServiceImpl`, `AnalyzerMappingCopyServiceImpl`, `AnalyzerServiceImpl`, `PluginRegistryService`, `MalariaSurveilanceJob`, `AggregateReportJob`, and ~8 others.

Every audit trail entry produced by these services is attributed to a phantom "system user 1" rather than the actual acting user. This destroys non-repudiation — a core ISO 15189 compliance requirement.

**Patch:**
- Where a request context is available, resolve `sysUserId` from `UserSessionData` in the session: `((UserSessionData) request.getSession().getAttribute(USER_SESSION_DATA)).getSystemUserId()`.
- For scheduled jobs with no HTTP context, create a dedicated system-job service account (e.g., `sysUserId = 2`) with a descriptive login name like `system_scheduler`, so audit entries are distinguishable from admin-user actions.
- Replace all 15+ hardcoded `"1"` literals as part of this phase.

---

### P3-I — `@EnableMethodSecurity` Missing — All `@PreAuthorize` Annotations Are No-ops

**Severity:** Critical | **File:** `SecurityConfig.java`

`SecurityConfig` does not carry `@EnableMethodSecurity(prePostEnabled = true)`. As a result, every `@PreAuthorize` annotation in the entire codebase — including all the ones added in Phases 1 and 2 — is silently ignored at runtime.

**Patch:**
```java
@Configuration
@EnableWebSecurity
@EnableMethodSecurity(prePostEnabled = true)  // ADD THIS
public class SecurityConfig { ... }
```
This is a single-line fix but it is foundational — without it, every role annotation in every phase is decorative.

---

### P3-J — CSRF Disabled for All `/rest/**` Endpoints

**Severity:** High | **File:** `SecurityConfig.java` (L424)

`.csrf(csrf -> csrf.ignoringRequestMatchers("/ValidateLogin", "/rest/**", ...))` globally disables CSRF for the entire REST surface, including all PHI-writing endpoints (`/rest/PatientManagement`, patient photos, sample results, etc.). A malicious page visited by an authenticated lab user can forge state-mutating requests to any of these.

**Patch:**
- Scope the CSRF exemption to machine-to-machine paths only:
  ```java
  .csrf(csrf -> csrf.ignoringRequestMatchers(
      "/ValidateLogin",
      "/rest/fhir/**",         // FHIR subscriber callbacks
      "/rest/analyzerResults/**",  // analyzer bridge
      "/api/OpenELIS-Global/rest/**"  // legacy external API
  ))
  ```
- Ensure the React frontend sends the CSRF token (already returned by `/session` as `session.CSRF`) as a default header on all mutating requests.

---

### P3-K — `PropertyUtils.copyProperties` Mass Assignment on Patient Entity

**Severity:** Medium | **File:** `PatientManagementRestController.java` (L120)

`PropertyUtils.copyProperties(patient, patientInfo)` does a reflection-based bulk copy of all same-named properties from the DTO to the entity. If `PatientManagementInfo` gains a field that shadows a sensitive entity field (`id`, `sysUserId`, `fhirUuid`, `lastUpdated`), a crafted request body can overwrite it. Protection relies entirely on `@Validated` not filtering property names.

**Patch:**
- Replace `PropertyUtils.copyProperties` with an explicit field-by-field mapping method.
- Only copy the specific fields that the patient management form is allowed to set.

---

### Phase 3 Risk Register

| ID | Severity | Finding |
|----|----------|---------|
| P3-A | Critical | Full patient profile by DB ID, no auth |
| P3-C | Critical | Patient photo, no ownership check |
| P3-I | Critical | `@EnableMethodSecurity` absent — all `@PreAuthorize` are no-ops |
| P3-D | High | National IDs in dashboard responses |
| P3-E | High | PHI written to INFO logs |
| P3-H | High | `sysUserId = "1"` hardcoded in 15+ services |
| P3-J | High | CSRF disabled for all `/rest/**` |
| P3-K | Medium | Mass assignment via `PropertyUtils.copyProperties` |

---

## Phase 4 — FHIR Endpoint Security

**Scope:** `FhirQueryRestController`, `InternalFhirApi`, `FhirRestfulServer`, `FhirTransformationController`, `FhirExportController`, `FhirActionController`, `ExternalPatientSearch`, `AnnotationWebAppInitializer`.

The codebase exposes FHIR through five independently routed surfaces. None carries any authorization.

| Surface | Path | Class |
|---------|------|-------|
| FHIR Query Proxy | `/rest/fhir/**` | `FhirQueryRestController` |
| Internal Passthrough | `/fhir/**` | `InternalFhirApi` |
| HAPI Facade Servlet | `/fhir/facade/*` | `FhirRestfulServer` |
| Transformation Trigger | `/OEToFhir`, `/PatientToFhir` | `FhirTransformationController` |
| Export / Admin Actions | `/dataexport/fhir`, `/fhir/optimizeStorage` | `FhirExportController`, `FhirActionController` |

---

### P4-A — `FhirQueryRestController` — Full SSRF and Parameter Injection

**Severity:** Critical | **File:** `FhirQueryRestController.java` (L59–315)

Four handler variants all build a FHIR store URL by concatenating an unvalidated `{resourceType}` path variable with verbatim query parameters. The `POST /_search` variant forwards an entirely attacker-controlled request body. The `GET /_search` variant forwards every query string parameter with no filtering at all. Any authenticated user can read all Patients, DiagnosticReports, Observations, and ServiceRequests, or inject FHIR operators like `_include=*` to traverse the entire graph.

**Patch (resource type allowlist):**
```java
private static final Set<String> ALLOWED_FHIR_TYPES = Set.of(
    "Patient", "Task", "ServiceRequest", "DiagnosticReport",
    "Observation", "Specimen", "Practitioner", "Encounter");

// At the top of every handler:
if (!ALLOWED_FHIR_TYPES.contains(resourceType)) {
    return ResponseEntity.badRequest().build();
}
```

**Patch (parameter allowlist):**
```java
private static final Set<String> ALLOWED_SEARCH_PARAMS = Set.of(
    "identifier", "subject", "patient", "status", "date",
    "_count", "_sort", "_format", "based-on");

// Replace the verbatim forwarding loop:
for (Map.Entry<String, String[]> entry : parameterMap.entrySet()) {
    if (!ALLOWED_SEARCH_PARAMS.contains(entry.getKey())) continue;
    // ... append to searchUrl
}
```

**Patch (resource ID validation):**
```java
if (!resourceId.matches("[a-zA-Z0-9\\-]{1,64}")) {
    return ResponseEntity.badRequest().build();
}
```

---

### P4-B — `InternalFhirApi` — Wildcard Proxy With No Path Normalization (SSRF)

**Severity:** Critical | **File:** `InternalFhirApi.java` (L51–143)

`@GetMapping("/**")` and `@PostMapping("/**")` forward any path under `/fhir/` to the local FHIR store. `extractFhirPath` does a simple string replacement of `/fhir` from the URI — no `..` prevention, no allowlist. The query string is appended completely raw. This is a full SSRF proxy for any internal path on the FHIR store host. The POST/PUT path uses `RequestDispatcher.forward()` with the same unsanitized path.

**Patch:**
- Validate the extracted `fhirPath` segment against the same `ALLOWED_FHIR_TYPES` set before building the target URL.
- Normalize the path with `URI.create(fhirPath).normalize()` and reject any result containing `..`.
- Replace the raw `HttpGet`/`HttpPost` construction with typed HAPI FHIR client calls (`fhirClient.read().resource(type).withId(id).execute()`) that cannot be redirected to arbitrary internal paths.
- Remove the wildcard `GET /**` and `POST /**` handlers entirely; replace with typed, resource-specific routes.

---

### P4-C — `FhirRestfulServer` Has No Authentication Interceptor

**Severity:** Critical | **File:** `FhirRestfulServer.java`, `AnnotationWebAppInitializer.java` (L35)

The HAPI `RestfulServer` is registered as a raw Java servlet at `/fhir/facade/*` via `servletContext.addServlet()`. Spring Security's filter chain does not apply to servlets registered this way unless `DelegatingFilterProxy` is explicitly mapped to that path — it is not. The servlet registers zero `IServerInterceptor` instances. Any unauthenticated HTTP client that knows the path can create, read, and update FHIR resources directly.

**Patch:**
- Implement a `FhirAuthorizationInterceptor extends AuthorizationInterceptor` that:
  1. Reads the caller's `HttpServletRequest` via `RequestDetails`.
  2. Validates a Spring Security session exists (`SecurityContextHolder.getContext().getAuthentication()`).
  3. Maps the requested FHIR operation and resource type against the user's permitted modules.
  4. Returns a `FHIR OperationOutcome` with HTTP 401/403 for unauthorized operations.
- Register it in `FhirRestfulServer.initialize()` via `registerInterceptor(new FhirAuthorizationInterceptor())` before any resource provider is set.
- Map `DelegatingFilterProxy` to `/fhir/facade/*` in `AnnotationWebAppInitializer` so the Spring Security chain also applies at the servlet boundary.

---

### P4-D — Transformation and Export Endpoints Have No Authorization

**Severity:** High | **Files:** `FhirTransformationController.java`, `FhirExportController.java`, `FhirActionController.java`

`GET /PatientToFhir?checkAll=true` triggers mass transformation of every patient in the database with configurable thread count and batch size — a DoS vector and a forced PHI sync to remote FHIR stores. `POST /dataexport/fhir` immediately exports all pending data to all configured remote FHIR servers. `POST /fhir/optimizeStorage` triggers a `$reindex` on the local FHIR store. None have any role check.

**Patch:**
- Add `isUserAdmin(request)` as the first check in each handler.
- For `/PatientToFhir` and `/OEToFhir`, cap `threads` to a configurable maximum (default 2) and `batchSize` to a maximum (default 50) regardless of what the caller supplies.
- Add an audit log entry before each operation recording the requesting user, IP, and parameters.

---

### P4-E — External Patient Search Uses `ALLOW_ALL_HOSTNAME_VERIFIER`

**Severity:** High | **File:** `ExternalPatientSearch.java` (L185)

The code explicitly sets `SSLSocketFactory.ALLOW_ALL_HOSTNAME_VERIFIER` — the comment even says "TODO shouldn't let a self signed cert through." Hostname verification is completely disabled for all connections to the external client registry. Credentials are also passed as URL query parameters, which appear in server access logs and `Referer` headers.

**Patch:**
- Replace `ALLOW_ALL_HOSTNAME_VERIFIER` with `SSLSocketFactory.STRICT_HOSTNAME_VERIFIER`.
- Load the client registry's CA certificate into the application trust store and reference it via the existing `server.ssl.trust-store` property.
- Move credentials from query parameters to HTTP Basic Authorization header.

---

### Phase 4 Risk Register

| ID | Severity | Finding |
|----|----------|---------|
| P4-A | Critical | Arbitrary FHIR resource type, SSRF, verbatim param injection |
| P4-B | Critical | `InternalFhirApi` wildcard proxy, no path normalization |
| P4-C | Critical | HAPI servlet outside Spring Security, no auth interceptor |
| P4-D | High | Transform/export/optimize endpoints, no admin gate |
| P4-E | High | External patient search — hostname verification disabled |

---

## Phase 5 — Infrastructure Hardening & Secrets Management

**Scope:** All `docker-compose*.yml` files, `volume/properties/common.properties`, `volume/properties/hapi_application.yaml`, `nginx.conf`, `nginx-prod.conf`, `nginx-proxy/Dockerfile`, `tomcat/hapi_server.xml`, `tomcat/oe_server.xml`, `Dockerfile`, `install/docker-entrypoint.sh`, `SecurityConfig.java` (encryption key), `PluginLoader.java`.

---

### P5-A — Hardcoded Credentials Across Every Compose Variant

**Severity:** Critical | **Files:** All Compose files, `common.properties`, `database.env`, `datasource.password`

The following credentials are committed to version control in plain text across every Compose variant and properties file:

| Secret | Current committed value | Location |
|--------|------------------------|----------|
| Admin password | `adminADMIN!` | 5 Compose files, CI workflow |
| DB app user password | `clinlims` | `docker-compose.yml`, `datasource.password` |
| DB superuser password | `admin` | `database.env` |
| SSL keystore password | `kspass` | All Compose files, `common.properties` |
| SSL truststore password | `tspass` | All Compose files, `common.properties` |
| AES encryption key | `kspass` | `common.properties` (same as keystore password) |
| VAPID private key | `FVONpka44MuWq6U8l3X4HY1hAfWM1v1IQB698gsS0KQ` | `application.properties` |

**Patch:**
- Replace every hardcoded value in every Compose file with `:?` enforcement:
  ```yaml
  - DEFAULT_PW=${OE_ADMIN_PASSWORD:?OE_ADMIN_PASSWORD must be set}
  - DB_PASSWORD=${OE_DB_PASSWORD:?OE_DB_PASSWORD must be set}
  - KEYSTORE_PW=${SSL_KEYSTORE_PASSWORD:?SSL_KEYSTORE_PASSWORD must be set}
  - TRUSTSTORE_PW=${SSL_TRUSTSTORE_PASSWORD:?SSL_TRUSTSTORE_PASSWORD must be set}
  ```
- Remove `encryption.general.password=kspass` from `common.properties`. Reference it via Docker secret: `encryption.general.password=${ENCRYPTION_KEY:?ENCRYPTION_KEY must be set}`. Remove the `:dev` fallback from `SecurityConfig`'s `@Value`.
- Remove the VAPID private key from `application.properties`. Add `vapid.private.key=${VAPID_PRIVATE_KEY:?}` and provide a `scripts/generate-vapid-keys.sh` helper for new deployments.
- Replace `datasource.password` (committed with literal `clinlims`) with a `.gitignore`d template. Add deployment documentation for Docker secrets usage.
- Add a `@PostConstruct` validator in `SecurityConfig` that throws `IllegalStateException` at startup if `encryption.general.password` matches any known-weak value (`kspass`, `dev`, `changeit`, `testtest`).

---

### P5-B — PostgreSQL Port Exposed to the Host Network

**Severity:** High | **Files:** `docker-compose.yml` (L23), `dev.docker-compose.yml` (L24)

`ports: - "15432:5432"` binds PostgreSQL to `0.0.0.0:15432`, making it reachable from any IP on the host. The default password is `clinlims` — identical to the username. This is a textbook remote database compromise vector for automated scanners.

**Patch:**
- Remove the `ports` block from `db.openelis.org` in `docker-compose.yml` entirely. Docker internal DNS (`db.openelis.org`) is sufficient for container-to-container communication.
- In `dev.docker-compose.yml`, change to `127.0.0.1:15432:5432` (localhost-only binding).

---

### P5-C — Nginx `proxy_ssl_verify off` on All Backend Hops

**Severity:** Medium | **Files:** `nginx.conf` (L49, L63, L113), `nginx-prod.conf`

`proxy_ssl_verify off` appears in three `location` blocks across both nginx config files. TLS between nginx and Tomcat provides no authenticity guarantee — any container on the Docker bridge network can impersonate the backend.

**Patch:**
- Change each instance to `proxy_ssl_verify on`.
- Add `proxy_ssl_trusted_certificate /etc/nginx/certs/oe-ca.crt;` pointing to the CA generated by `itechuw/certgen`.
- Mount the CA certificate into the nginx container via the Compose volume definition.

---

### P5-D — Nginx Has Zero Security Response Headers

**Severity:** High | **Files:** `nginx.conf`, `nginx-prod.conf`

No `add_header` directive exists anywhere in either nginx config. Missing headers include HSTS, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, and `server_tokens`. The existing CSP is set only in Spring MVC and does not apply to nginx-proxied responses.

**Patch:**
- Create `nginx/security_headers.conf`:
  ```nginx
  add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
  add_header X-Frame-Options "SAMEORIGIN" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
  server_tokens off;
  ```
- Add `include /etc/nginx/security_headers.conf;` in both `nginx.conf` and `nginx-prod.conf`.

---

### P5-E — EOL nginx Base Image Running as Root

**Severity:** Medium | **File:** `nginx-proxy/Dockerfile` (L1)

`FROM nginx:1.15-alpine` — released 2018, end-of-life. Contains CVE-2019-9511/9513/9516 (HTTP/2 DoS) and CVE-2021-23017 (DNS off-by-one). The final Dockerfile instruction is `USER root`, so the container starts as root. The nginx worker process then also runs as root.

**Patch:**
- Change base image to `nginx:1.26-alpine` (current stable).
- Add `USER nginx` as the final Dockerfile instruction.
- In `nginx.conf`, set `user nginx;` in the `worker_processes` block.

---

### P5-F — HAPI FHIR Configured With CORS Wildcard and `allow_external_references: true`

**Severity:** High | **File:** `volume/properties/hapi_application.yaml`

```yaml
cors:
  allow_Credentials: true
  allowed_origin:
    - '*'
allow_external_references: true
openapi_enabled: true
```

`allowed_origin: ['*']` with `allow_Credentials: true` means any webpage can make credentialed cross-origin requests to the FHIR store. `allow_external_references: true` lets the HAPI server resolve references in submitted resources that point to arbitrary external URLs — an SSRF vector rooted in the FHIR store configuration. `openapi_enabled: true` serves a full interactive Swagger UI without authentication.

**Patch:**
- Replace `allowed_origin: ['*']` with the explicit nginx proxy origin.
- Set `allow_external_references: false`.
- Set `openapi_enabled: false` in the volume (runtime) config. Keep it enabled only in the dev profile.

---

### P5-G — HAPI Tomcat Shutdown Port Active, Access Log Disabled, `autoDeploy` On

**Severity:** Medium | **Files:** `tomcat/hapi_server.xml`, `tomcat/oe_server.xml`

The HAPI Tomcat listens on port 8005 for shutdown commands (`<Server port="8005">`). Any container on the Docker bridge can send `SHUTDOWN` to gracefully stop the FHIR store. The OE webapp correctly disables this (`port="-1"`). The HAPI access log valve is commented out — all FHIR store HTTP access is unlogged. `oe_server.xml` has `autoDeploy="true"`, meaning any WAR dropped into `webapps/` is automatically deployed without a restart.

**Patch:**
- Set `<Server port="-1">` in `hapi_server.xml`.
- Uncomment the `AccessLogValve` in `hapi_server.xml`.
- Set `autoDeploy="false"` in `oe_server.xml`.

---

### P5-H — No Container Resource Limits

**Severity:** Medium | **Files:** All Compose files

No service defines `mem_limit`, `cpus`, or `pids_limit`. The transformation DoS from P4-D (unlimited async threads) can exhaust all host memory because there is no container ceiling to trigger an OOM kill before the host is affected.

**Patch:**
- Add resource limits to each service in `docker-compose.yml`:
  ```yaml
  deploy:
    resources:
      limits:
        memory: 2g
        cpus: '2.0'
  ```
- Tune values per service (HAPI and the webapp need more than nginx or the cert generator).

---

### P5-I — Dockerfile Ends With `USER root`

**Severity:** Medium | **File:** `Dockerfile` (L71)

The final instruction before `ENTRYPOINT` is `USER root`. Any `docker exec` session or orchestrator that bypasses the entrypoint starts as root. The entrypoint drops to `tomcat_admin` via `exec su`, but this is fragile.

**Patch:**
- Add a dedicated `tomcat_admin` user in the Dockerfile and make it the final `USER` instruction.
- The `chown` operations in `docker-entrypoint.sh` that require root should be handled during image build, not at runtime.

---

### P5-J — Unsigned JARs Loaded From Volume at Startup

**Severity:** Critical | **File:** `PluginLoader.java` (L68)

At startup, every `.jar` in `/var/lib/openelis-global/plugins/` is loaded and executed with no integrity check. Any attacker with write access to the host's `./volume/plugins/` directory (mapped as a Docker volume) can drop a malicious JAR and achieve full application-level code execution.

**Patch:**
- Implement JAR signature verification using a configurable signing certificate (`PLUGIN_SIGNING_CERT` environment variable).
- Reject and log any JAR that does not carry a valid signature before loading.
- As an interim measure while signing infrastructure is established, maintain a SHA-256 checksum allowlist in a file outside the plugins volume.
- Change the plugins volume mount to `read_only: true` after all expected plugins are loaded at first start.

---

### Phase 5 Risk Register

| ID | Severity | Finding |
|----|----------|---------|
| P5-A | Critical | Credentials hardcoded in VCS across all Compose files |
| P5-J | Critical | Unsigned JARs loaded from Docker volume |
| P5-B | High | PostgreSQL exposed on host port 15432 |
| P5-D | High | Zero nginx security response headers |
| P5-F | High | HAPI CORS wildcard + `allow_external_references` |
| P5-C | Medium | `proxy_ssl_verify off` on all nginx→Tomcat hops |
| P5-E | Medium | EOL nginx 1.15 image, running as root |
| P5-G | Medium | HAPI shutdown port active, access log off, `autoDeploy` on |
| P5-H | Medium | No container resource limits |
| P5-I | Medium | Dockerfile ends with `USER root` |

---

## 4. Timeline

| Week | Deliverable |
|------|-------------|
| 1 | Community bonding. Finalize mentor-approved priority ordering. Audit existing `SystemModuleUrl` registrations to prepare the Liquibase changeset inventory for P1-A6. |
| 2 | P1-A1 (session ID), P1-A2 (XFF audit log), P1-A3 (default password). JUnit 4 unit tests for each. Draft PR. |
| 3 | P1-A4 (SAML provisioning), P1-A5 (`getGrantedAuthorities`), P1-A6 (fail-closed interceptor + Liquibase changesets). Phase 1 PR submitted. |
| 4 | P2-A1/A2/A3 (BOLA guards on patient search, audit trail, user directory). `@PreAuthorize` + module registrations. |
| 5 | P2-B1 (mass deletion), P2-C1/C2/C3 (import, reindex, logging). Admin guards, audit log entries. |
| 6 | P2-D1 (FHIR allowlists), P2-E1/E2 (file upload, HL7 fallback). Integration tests for all Phase 2 items. Phase 2 PR submitted. |
| 7 | P3-I (`@EnableMethodSecurity` — foundational), P3-A (patient detail), P3-C (patient photo). |
| 8 | P3-D (dashboard masking), P3-E (log PHI removal, dev profile), P3-H (`sysUserId` audit across 15+ files). |
| 9 | P3-J (CSRF scope fix), P3-K (mass assignment), P3-F/G (defence-in-depth). Integration tests. Phase 3 PR submitted. |
| 10 | P4-A (full FHIR allowlists and param filtering), P4-B (`InternalFhirApi` SSRF mitigation). |
| 11 | P4-C (`FhirAuthorizationInterceptor` + DelegatingFilterProxy mapping), P4-D (transform/export gates), P4-E (TLS). Phase 4 PR submitted. |
| 12 | P5-A (all credentials → `:?` enforcement), P5-B (DB port), P5-C (nginx TLS verify), P5-D (nginx headers). Update deployment docs. |
| 13 | P5-E (nginx base image), P5-F (HAPI config), P5-G (Tomcat hardening), P5-H/I (resource limits, USER root). P5-J (JAR signing). Full E2E run against hardened stack. Phase 5 PR submitted. |
| 14 | Buffer. Address review feedback. Write final report. Add a security checklist to `AGENTS.md` and `PULL_REQUEST_TIPS.md` so future contributors know what to check before opening a PR. |

---

## 5. Testing Plan

The repository uses JUnit 4 (`org.junit.Test`) and `BaseWebContextSensitiveTest`. I will not introduce JUnit 5, `@SpringBootTest`, `@WebMvcTest`, or `@DataJpaTest`.

**Unit tests (Mockito, `@Mock`/`@InjectMocks`)** for all logic that does not require a Spring context:
- `getGrantedAuthorities()` — verify admin user produces `ROLE_ADMIN`; non-admin does not.
- `ModuleAuthenticationInterceptor` — verify unregistered REST path returns `false`; allowlisted path returns `true`.
- FHIR allowlist validation — verify disallowed resource types and invalid resource IDs each return 400.
- `validateAdminPassword()` — verify known-weak passwords throw `IllegalStateException` at startup.

**Spring context integration tests (`BaseWebContextSensitiveTest`)** for filter chain and controller behaviour:
- `GET /session` does not contain `sessionId` in response body after P1-A1.
- `POST /DatabaseCleaningRequest` as non-admin returns 403 after P2-B1.
- `GET /rest/patient-search-results` as low-privilege user returns 403 after P2-A1 + P3-I.
- `GET /rest/fhir/Binary` (disallowed type) returns 400 after P4-A.
- `POST /rest/fhir/Patient/_search?_query=everything` has `_query` stripped after P4-A param filtering.

**Cypress E2E** run via `./scripts/run-e2e-like-ci.sh` before every PR that touches auth flow, session polling, or the FHIR UI integration. `npm run cy:failfast` during development iterations. E2E suite must pass against a stack started with all `:?` required variables supplied — not with any hardcoded fallback.

**Build format:** `mvn spotless:apply` before every Java PR. `cd frontend && npm run format` before every frontend PR. Fast sanity check: `mvn clean install -DskipTests -Dmaven.test.skip=true`.

---

## 6. Constraints I Will Respect

- **JUnit 4 only.** No JUnit 5 annotations or Spring Boot test patterns anywhere.
- **One PR per phase, one concern per commit.** No mixing security fixes with unrelated refactors.
- **Liquibase for all schema changes.** Every new `SystemModuleUrl` registration or schema change gets a versioned changeset with rollback.
- **No country-specific branching.** Any behavioral variation (SSO auto-provisioning on/off, allowed CORS origins) is driven by configuration properties, not `if ("MG".equals(countryCode))` conditionals.
- **Carbon Design System for any UI changes.** No custom CSS, no Bootstrap.
- **`mvn spotless:apply` and `npm run format` on every PR.**

---

## 7. Why This Project

OpenELIS is running in facilities where lab results affect treatment decisions and audit trails are reviewed for accreditation. The fact that a session ID is broadcast to JavaScript every three seconds, that any authenticated lab worker can read every patient record in the system, that the FHIR proxy will forward a request to any internal path with no validation, and that the admin password is `adminADMIN!` in the public repository — these are not theoretical concerns.

The fixes I am proposing are mostly unglamorous: removing a field from a DTO, changing a `return true` to a `return false`, adding an annotation that was always supposed to be there. But they are the right kind of work for a healthcare system, and I want to do them correctly.

---

*Proposal submitted for Google Summer of Code 2025.*
*Project: OpenELIS Global — Security Hardening: Authentication, Access Control, PHI Protection, FHIR, and Infrastructure.*
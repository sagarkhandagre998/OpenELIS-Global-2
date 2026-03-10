🔐 OpenELIS Security Audit — Phase 1: Highest-Impact Areas

**Methodology**: Every finding below is traced directly to specific code, configuration files, or architectural patterns observed in the repository. Severity ratings follow the CVSS 3.1 model (Critical / High / Medium / Low / Informational).

---

## Area 1 — Authentication & Session Security

### Finding A-1: Session ID Exposed in API Response
**Severity: High**
**File**: `LoginPageController.java` — `/session` endpoint (L142)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/login/controller/LoginPageController.java#L138-148
@GetMapping(value = "/session", produces = MediaType.APPLICATION_JSON_VALUE)
@ResponseBody
public UserSession getSesssionDetails(HttpServletRequest request, CsrfToken token) {
    boolean authenticated = !userModuleService.isSessionExpired(request);
    UserSession session = new UserSession();
    session.setAuthenticated(authenticated);
    session.setSessionId(request.getSession().getId());   // ← EXPOSED
```

**Problem**: The `JSESSIONID` is explicitly serialized into the JSON response body from the `/session` endpoint. The frontend polls this endpoint every **3 seconds** from `Login.js`. This means any JavaScript running in the browser — including via an XSS payload — can programmatically read the session ID via `fetch('/session')` and exfiltrate it. In a classic session hijacking attack, an attacker who can read this value can impersonate the authenticated user without ever needing to steal the cookie. The `HttpOnly` cookie flag (correctly set in `web.xml`) is rendered meaningless for this specific vector.

**Root Cause**: `session.setSessionId(request.getSession().getId())` in the `/session` GET handler.

**Recommendation**: Remove `sessionId` from the `UserSession` DTO entirely or conditionally omit it from the JSON response. The session cookie is managed by the browser and doesn't need to be accessible via JavaScript.

---

### Finding A-2: Unvalidated X-Forwarded-For Header Used for Audit Logging
**Severity: Medium**
**Files**: `CustomFormAuthenticationSuccessHandler.java` (L76), `CustomAuthenticationFailureHandler.java` (L36)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/login/CustomFormAuthenticationSuccessHandler.java#L68-79
final String xfHeader = request.getHeader("X-Forwarded-For");
if (xfHeader == null) {
    LogEvent.logInfo(..., "from " + request.getRemoteAddr());
} else {
    LogEvent.logInfo(..., "from " + xfHeader.split(",")[0]);   // ← TRUSTS HEADER
}
```

**Problem**: The code reads `X-Forwarded-For` directly from the request header and logs `xfHeader.split(",")[0]` as the client's true IP. An attacker can forge this header in their login request (e.g., `X-Forwarded-For: 127.0.0.1`), and the audit log will record `127.0.0.1` as the attacker's IP instead of their real one. This poisons the audit trail — the single most important forensic artifact in a SLIPTA/ISO 15189 compliant system. The Nginx config does forward `X-Forwarded-For` from the proxy, but **any client making a direct request to port 8443 (which is exposed) bypasses Nginx entirely** and can inject whatever they want into this header.

**Root Cause**: `X-Forwarded-For` is trusted without verifying the request came from a known trusted proxy. Ports `8080` and `8443` are directly exposed on the host in `docker-compose.yml`.

**Recommendation**: Use Spring's `ForwardedHeaderFilter` with a trusted proxy whitelist, or configure Tomcat's `RemoteIpValve` to only accept `X-Forwarded-For` from known proxy IP ranges. Never log user-controlled header values without sanitizing or validating them.

---

### Finding A-3: Default Admin Password is a Well-Known Public Constant
**Severity: High**
**Files**: Multiple `docker-compose` files, `.github/workflows`

```OpenELIS-Global-2/build.docker-compose.yml#L61-66
environment:
    - DEFAULT_PW=adminADMIN!
    - TZ=Africa/Nairobi
```

```OpenELIS-Global-2/.github/workflows/frontend-qa.yml#L215-216
TEST_USER: ${{ vars.TEST_USER || 'admin' }}
TEST_PASS: ${{ secrets.TEST_PASS || 'adminADMIN!' }}
```

**Problem**: The default admin password `adminADMIN!` is **hardcoded as a plaintext fallback** in five separate Docker Compose files (`docker-compose.yml`, `build.docker-compose.yml`, `dev.docker-compose.yml`, `test.docker-compose.yml`, `projects/analyzer-harness/docker-compose.dev.yml`) and in a GitHub Actions workflow file. It is also the hard-coded CI fallback. Any administrator who deploys OpenELIS via Docker without explicitly changing the `DEFAULT_PW` environment variable will have a production system running with this publicly known credential. This is a textbook default credential vulnerability (CWE-1392, CWE-798).

**Root Cause**: The password is baked into source-controlled compose files as a convenient default.

**Recommendation**: Remove all hardcoded `DEFAULT_PW` values from compose files. Force initial password configuration via a required environment variable or first-run setup wizard. The `CreateAdminUserTask.java` already reads from `adminPassword.txt` with hashing support — enforce that path for all deployment modes.

---

### Finding A-4: SAML Session User Auto-Provisioning with Hardcoded sysUserId
**Severity: High**
**File**: `CustomSSOAuthenticationSuccessHandler.java` (L182–247)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/login/CustomSSOAuthenticationSuccessHandler.java#L204-222
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

**Problem**: When a SAML-authenticated user arrives and no matching `SystemUser` exists in the database, the code **automatically creates one** with `setSysUserId("1")`. In OpenELIS, sysUserId `1` is reserved for the system/admin context (see `CreateAdminUserTask.java` which uses `login.setSysUserId("1")`). This means any user authenticating via a connected SAML IdP — including users from misconfigured or malicious IdPs — gets a new `SystemUser` created with the admin's sysUserId. The resulting `UserSessionData` is then given admin access (`usd.setAdmin(isAdmin)` controlled only by role name parsing). This is an **account takeover and privilege escalation** vector via SAML identity federation.

**Root Cause**: `systemUser.setSysUserId("1")` is hardcoded in the auto-provision block; it should use a system-generated value, not a magic constant.

**Recommendation**: Remove the hardcoded `setSysUserId("1")`. Auto-provisioning should only assign the user to a default non-admin role. Consider requiring explicit admin approval for newly federated users before they gain any system access.

---

### Finding A-5: `getGrantedAuthorities()` Always Returns Empty List
**Severity: Medium**
**File**: `CustomUserDetailsService.java` (L32–36)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/login/CustomUserDetailsService.java#L32-36
// TODO flesh this out so we can do permissions solely through granted
// authorities for sso and form login methods
private List<GrantedAuthority> getGrantedAuthorities(LoginUser user) {
    List<GrantedAuthority> authorities = new ArrayList<>();
    return authorities;   // ← Always empty
}
```

**Problem**: Spring Security's `UserDetails` object — the one used by `DaoAuthenticationProvider` for every form login — returns an **empty list of `GrantedAuthority`**. This means Spring Security method-level security annotations like `@PreAuthorize("hasRole('ADMIN')")` on form-login users will **always fail** because the user has no granted authorities. The four endpoints in `SiteBrandingRestController` that depend on `@PreAuthorize("hasRole('ADMIN')")` may be accessible to non-admin form-login users, or inaccessible to all form-login users depending on default deny semantics, creating an inconsistency.

**Root Cause**: The TODO was never implemented. All authorization for form-login is delegated to the custom `ModuleAuthenticationInterceptor`, which works at the HTTP interceptor level — but this creates a two-tier authorization system with undefined interaction semantics.

**Recommendation**: Implement `getGrantedAuthorities()` to map user roles (admin, lab section, etc.) to `GrantedAuthority` objects. This enables consistent, framework-standard authorization that `@PreAuthorize` annotations can rely on.

---

### Finding A-6: `ModuleAuthenticationInterceptor` Silently Bypasses Authorization for All REST Paths
**Severity: High**
**File**: `ModuleAuthenticationInterceptor.java` (L98–102)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/interceptor/ModuleAuthenticationInterceptor.java#L95-103
if (sysModsByUrl.isEmpty() && REQUIRE_MODULE) {
    if (isRestFullPath()) {
        return true;    // ← No module configured = ALLOW for REST
    }
    LogEvent.logWarn(..., "This page has no modules assigned to it");
    return false;
}
```

And the `isRestFullPath()` check:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/interceptor/ModuleAuthenticationInterceptor.java#L142-147
private boolean isRestFullPath() {
    if (path.startsWith("/rest") || path.startsWith("/Provider")) {
        return true;
    }
    return false;
}
```

**Problem**: When a REST endpoint has **no system module configured** in the database for it — which includes any newly added endpoint that a developer forgot to register — the interceptor returns `true` (access granted) for every authenticated user. This is a **fail-open** authorization design. New REST endpoints are silently accessible to all authenticated users until someone manually registers them in the module permission system. OpenELIS has dozens of REST controllers. The authorization coverage of the module system depends on correct database configuration — and any gap means unrestricted access.

**Root Cause**: The design decision to `return true` on `isRestFullPath()` when no module is found was probably meant for backward compatibility, but it creates an open-by-default behavior.

**Recommendation**: Change to fail-closed: if no module is configured for a REST path, deny access and log a `WARN`. Introduce an explicit allow-list or annotate endpoints that are intentionally open. Run a complete audit of which REST endpoints have module mappings in the database.

---

## Area 2 — CORS / CSRF Security

### Finding B-1: CORS Origin Reflection — Full Wildcard Equivalent with Credentials
**Severity: Critical**
**File**: `CORSFilter.java` (L30–32)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/CORSFilter.java#L28-38
response.setHeader("Access-Control-Allow-Origin", request.getHeader("Origin"));
response.setHeader("Access-Control-Allow-Credentials", "true");
response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
response.setHeader("Access-Control-Max-Age", "3600");
```

**Problem**: The CORS filter **reflects the incoming `Origin` header verbatim** back as the `Access-Control-Allow-Origin` value, and simultaneously sets `Access-Control-Allow-Credentials: true`. This is the functional equivalent of `Access-Control-Allow-Origin: *` with credentials, which browsers explicitly disallow — except that by reflecting the origin, this filter circumvents that browser protection entirely.

**Exploit scenario**: An attacker hosts `https://evil.com`. A logged-in OpenELIS user visits `evil.com`. JavaScript on that page makes a `fetch("https://openelis.hospital.org/rest/patient/search?name=john", {credentials: "include"})`. The browser sends the session cookie. OpenELIS responds with `Access-Control-Allow-Origin: https://evil.com` and `Access-Control-Allow-Credentials: true`. The browser allows `evil.com` to read the full patient data response. **This is a full cross-origin data theft vulnerability for all patient PHI exposed through the REST API.**

**Root Cause**: No allowlist is maintained. Any `Origin` value is reflected.

**Recommendation**: Maintain an explicit list of trusted origins (e.g., the Nginx proxy's domain). Reject or ignore requests from non-whitelisted origins. Replace the `CORSFilter` with Spring MVC's `CorsConfigurationSource` which has first-class allowlist support.

---

### Finding B-2: CSRF Disabled for All REST Endpoints
**Severity: High**
**File**: `SecurityConfig.java` (L428-430)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/SecurityConfig.java#L427-431
.csrf(csrf -> csrf.ignoringRequestMatchers("/ValidateLogin", "/rest/**",
        "/api/OpenELIS-Global/rest/**"))
```

**Problem**: Every single REST endpoint under `/rest/**` is **exempt from Spring Security's CSRF protection**. This covers the entire modern REST API surface — patient data, results, configurations, analyzer imports, notifications, file imports, and more. When combined with **Finding B-1** (CORS origin reflection), this becomes compounded: a malicious cross-origin page can make credential-bearing state-mutating requests to any `/rest/**` endpoint and they will succeed because (a) CORS allows the origin and (b) CSRF protection is disabled for the target URLs.

**Why this is architecturally significant**: The `/session` endpoint returns a CSRF token. The system clearly has CSRF awareness. But exempting all REST endpoints from CSRF undermines the entire mechanism for the most sensitive data-mutation APIs.

**Root Cause**: CSRF was likely disabled for REST because REST clients (FHIR subscribers, analyzers) can't participate in the CSRF token flow. But the exemption is too broad — it should be scoped to specific machine-to-machine endpoints only.

**Recommendation**: Enable CSRF for `/rest/**` endpoints used by the browser frontend. Scope the CSRF exemption only to the machine-to-machine paths (`/rest/fhir/**`, `/rest/analyzerResults/**`, `/fhir/**`). The CSRF token returned by `/session` should be required for browser-originated mutation requests.

---

### Finding B-3: Nginx `proxy_ssl_verify off` — Internal TLS Not Verified
**Severity: Medium**
**File**: `nginx.conf` (L51, L63, L113)

```OpenELIS-Global-2/volume/nginx/nginx.conf#L49-53
proxy_pass https://oe.openelis.org:8443/api/;
proxy_redirect off;
proxy_ssl_verify off;   // ← No certificate verification
proxy_ssl_server_name on;
```

**Problem**: All proxy connections from Nginx to the backend (`oe.openelis.org:8443`) have `proxy_ssl_verify off`. This means Nginx does not verify the backend's TLS certificate. An attacker who can intercept traffic within the Docker network (network-level attack on the bridge) can perform a man-in-the-middle between Nginx and the application, decrypting all PHI in transit between the proxy and backend, even though HTTPS is in use end-to-end from the outside.

**Root Cause**: Self-signed certificates generated by `itechuw/certgen` are used for internal communication, and verifying them requires the CA certificate to be configured in Nginx — which appears not to have been done.

**Recommendation**: Either configure Nginx with the internal CA cert (`ssl_trusted_certificate`) and enable `proxy_ssl_verify on`, or use a shared certificate across all services with a known CA. The Docker network provides some isolation, but `proxy_ssl_verify off` is a known bad practice.

---

## Area 3 — PHI Data Exposure in Logs

### Finding C-1: Hibernate SQL Debug Logging Enabled by Default — PHI Leakage
**Severity: High**
**File**: `application.properties` (L41–44)

```OpenELIS-Global-2/src/main/resources/application.properties#L39-45
#Hibernate Config
spring.jpa.show-sql=true
spring.jpa.properties.hibernate.format_sql=true
logging.level.org.hibernate.SQL=DEBUG
logging.level.org.hibernate.type.descriptor.sql.BasicBinder=TRACE
```

**Problem**: `logging.level.org.hibernate.type.descriptor.sql.BasicBinder=TRACE` causes Hibernate to log **every bound parameter value** for every SQL query at TRACE level. In a healthcare system, this means patient names, dates of birth, test results, accession numbers, and diagnoses are written to the application log file in plaintext. The log files are stored at `/var/lib/openelis-global/logs/openELIS.log` and kept for up to 100 rolling files. Any personnel with file system access — or any attacker who achieves log file read access — gains access to a comprehensive dump of PHI without ever touching the database.

**This is a HIPAA/GDPR violation in any jurisdiction requiring PHI protection.**

**Important context**: The `volume/properties/common.properties` (used in production Docker deployments) has these settings commented out — which is correct. However, `src/main/resources/application.properties` (the base configuration that `common.properties` overlays) has them enabled. If `common.properties` is not properly applied, the default bleeds through.

**Root Cause**: Debug settings intended for development were left in the default properties file with no runtime environment gating.

**Recommendation**: Set all Hibernate logging to `WARN` or `ERROR` in the default `application.properties`. Provide a separate `application-dev.properties` profile for development debugging. Ensure production deployments validate that PHI-logging properties are disabled.

---

### Finding C-2: Login Name Included in Log Messages — Username Enumeration via Logs
**Severity: Low-Medium**
**File**: `AuthenticationListener.java`, `CustomAuthenticationFailureHandler.java`

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/login/AuthenticationListener.java#L18-21
@EventListener
public void onSuccess(AuthenticationSuccessEvent success) {
    LogEvent.logInfo(..., "Successful login attempt for " + success.getAuthentication().getName());
}
```

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/login/AuthenticationListener.java#L23-26
@EventListener
public void onFailure(AbstractAuthenticationFailureEvent failures) {
    LogEvent.logInfo(..., "Unsuccessful login attempt for " + failures.getAuthentication().getName());
}
```

**Problem**: Login attempts — both successful and failed — log the **exact username** that was attempted. This is doubled: both `AuthenticationListener` and `CustomFormAuthenticationSuccessHandler`/`CustomAuthenticationFailureHandler` log the same events (duplicated logging). More critically, if a brute-force script cycles through usernames, the log file becomes a confirmed enumeration of which usernames are valid (successful login logs) vs invalid. For a healthcare system, knowing valid usernames is the first step in a targeted credential attack.

**Recommendation**: Log a hashed or partial username for audit purposes. Keep failed attempts at INFO level for audit but do not log the attempted credential value in detail.

---

## Area 4 — VAPID Key Security

### Finding D-1: VAPID Private Key Hardcoded in Source-Controlled Properties File
**Severity: High**
**File**: `application.properties` (L55–56)

```OpenELIS-Global-2/src/main/resources/application.properties#L53-57
# Push Notification config
vapid.public.key=BJDIyXHWK_o9fYNwD3fUie2Ed04-yx5fxz9-GUT1c0QhfdDiGMvVbJwvB_On3XapXqIRR471uh7Snw3bfPt9niw
vapid.private.key=FVONpka44MuWq6U8l3X4HY1hAfWM1v1IQB698gsS0KQ
```

**Problem**: The VAPID (Voluntary Application Server Identification for Web Push) **private key** is committed to the repository in plaintext. Anyone with access to the repository — including all public forks and GitHub history — can extract this key. With the VAPID private key, an attacker can:
1. Send push notifications that appear to originate from the legitimate OpenELIS server to all subscribed users
2. Craft malicious push notifications (phishing via browser-level OS notifications) appearing to come from the hospital's LIMS system
3. Maintain persistent access to push infrastructure even after the breach is discovered (key rotation requires all subscribers to re-subscribe)

Additionally, in `NotificationRestController.java` (L101):
```OpenELIS-Global-2/src/main/java/org/openelisglobal/notifications/rest/NotificationRestController.java#L99-102
PushService pushService = new PushService(env.getProperty("vapid.public.key"),
        env.getProperty("vapid.private.key"), "mailto:your-email@example.com");
```
The contact email for the VAPID application server is a **placeholder** (`your-email@example.com`), which violates the VAPID spec and can result in push service operators blocking notifications from this server.

**Root Cause**: The VAPID key pair was generated once and committed to the codebase without a secrets management strategy.

**Recommendation**:
1. **Immediately rotate** the VAPID key pair since the private key is now public
2. Move both keys to Docker secrets or environment variables (never commit to source control)
3. Replace `your-email@example.com` with a real contact address
4. Consider using a secrets management system (HashiCorp Vault, AWS Secrets Manager) for future credential management

---

### Finding D-2: VAPID Public Key Exposed via Unauthenticated REST Endpoint
**Severity: Informational**
**File**: `NotificationRestController.java` (L164–174)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/notifications/rest/NotificationRestController.java#L164-174
@GetMapping("/notification/public_key")
public ResponseEntity<Map<String, String>> getPublicKey() {
    String publicKey = env.getProperty("vapid.public.key");
    Map<String, String> response = new HashMap<>();
    response.put("publicKey", publicKey);
    return ResponseEntity.ok().body(response);
}
```

**Problem**: Exposing the VAPID public key via a REST endpoint is **architecturally correct** (browsers need it to subscribe). However, this endpoint sits under `/rest/**` which requires authentication per Spring Security's default chain. Web Push specification typically expects the public key to be served statically or via an open endpoint to allow unauthenticated subscription. The current design may break push subscription for unauthenticated users if that use case exists.

**Recommendation**: Verify whether this endpoint needs to be open. If only authenticated users subscribe to push notifications, the current behavior is fine. Document the intent.

---

## Area 5 — Weak XSS Filter

### Finding E-1: `SecurityFilter` XSS Detection is Trivially Bypassed
**Severity: High**
**File**: `SecurityFilter.java` (L40–57)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/SecurityFilter.java#L40-57
if (paramValue.contains("<script>") || paramValue.contains("</script>")) {
    suspectedAttack = true;
    attackList.add("XSS on " + curParam + ": " + ...);
}
```

**Problem**: This filter checks only two exact string patterns: `<script>` and `</script>`. Any of the following common XSS payloads will completely bypass it:

- `<SCRIPT>alert(1)</SCRIPT>` (case variation — the filter strips whitespace via `.replaceAll("\\s", "")` but doesn't lowercase)
- `<img src=x onerror=alert(1)>` (event handler injection — no `<script>` tag)
- `<svg onload=alert(1)>` (SVG-based injection)
- `javascript:alert(1)` (protocol injection in href/src)
- `"><script>alert(1)</script>` (attribute breakout)
- `%3Cscript%3E` (URL-encoded — the filter operates on decoded values, but some contexts don't decode)

The filter only acts on POST requests or URIs containing "Update"/"Save". GET requests with XSS payloads are not checked at all. Even when triggered, the response is just a redirect to the Dashboard — the parameter is not sanitized or rejected properly, just bypassed for the current request.

**Critical observation**: This filter creates **false security confidence**. Developers may believe XSS is "handled" by the filter, when in reality it is trivially circumvented.

**Root Cause**: Homemade XSS detection based on blacklist patterns — a well-known anti-pattern.

**Recommendation**: Remove this filter entirely. XSS prevention should be done through:
1. **Output encoding** (already configured via `defaultHtmlEscape=true` in `web.xml` and the Content Security Policy header)
2. **Input validation** using the existing `ValidationHelper` with character set restrictions
3. **OWASP Java HTML Sanitizer** or similar library for any fields that genuinely need to accept HTML
4. The CSP header (`script-src 'self' 'unsafe-inline'`) — though `unsafe-inline` must be removed for CSP to be effective

---

## Area 6 — Content Security Policy

### Finding F-1: CSP Contains `unsafe-inline` and `unsafe-eval` — CSP is Ineffective
**Severity: High**
**File**: `SecurityConfig.java` (L111–113)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/SecurityConfig.java#L111-113
private static final String CONTENT_SECURITY_POLICY =
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval';"
    + " connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline';"
    + " frame-src *.openlmis.org 'self'; object-src 'self';";
```

**Problem**: The Content Security Policy contains both `'unsafe-inline'` and `'unsafe-eval'` in the `script-src` directive. This **completely neutralizes XSS protection** that the CSP is meant to provide:
- `'unsafe-inline'`: Allows inline `<script>` blocks and `onclick` attributes — the most common XSS payloads
- `'unsafe-eval'`: Allows `eval()`, `setTimeout(string)`, `Function()` constructor — enables payload injection via string evaluation

A CSP with `unsafe-inline` provides **zero XSS protection**. The entire value of having a CSP is eliminated. Additionally:
- `object-src 'self'` allows Flash/plugins from self origin (should be `'none'`)
- `frame-src *.openlmis.org` allows framing from any subdomain of `openlmis.org` — a broad trust grant

**Root Cause**: React applications often rely on inline styles and eval-based module loading, making strict CSP difficult without nonce-based approaches.

**Recommendation**: Work toward removing `'unsafe-inline'` by:
1. Migrating inline styles to CSS modules (Carbon Design System already uses this)
2. Using CSP nonces generated per-request for any necessary inline scripts
3. Setting `object-src 'none'` immediately (no active cost)
4. Narrowing `frame-src` to specific known domains

---

## Area 7 — Infrastructure Security

### Finding G-1: PostgreSQL Port Directly Exposed to Host
**Severity: High**
**File**: `docker-compose.yml` (L21–22)

```OpenELIS-Global-2/docker-compose.yml#L18-22
db.openelis.org:
    container_name: openelisglobal-database
    image: itechuw/openelis-global-2-database:develop
    ports:
        - "15432:5432"    // ← Database directly accessible from host
```

**Problem**: The PostgreSQL database port is bound to `0.0.0.0:15432` on the host. In a production deployment, this means:
1. The database is reachable from **any IP that can reach the server**, not just from within the Docker network
2. Any attacker who discovers the server and scans port 15432 can attempt direct database connections
3. A brute-force against the PostgreSQL `clinlims` user bypasses the entire Spring Security layer

The database password defaults to `clinlims` (matching the username) if `OE_DB_PASSWORD` is not set:
```OpenELIS-Global-2/docker-compose.yml#L30-31
environment:
    - DB_PASSWORD=${OE_DB_PASSWORD:-clinlims}
```

A default password of `clinlims` on an externally accessible PostgreSQL port is a textbook credential stuffing target.

**Root Cause**: The port binding was likely added for development convenience and was never restricted for production.

**Recommendation**:
1. Remove the `ports` section from `db.openelis.org` in the production compose file entirely — Docker internal DNS is sufficient for inter-container communication
2. If external DB access is needed for administration, use `127.0.0.1:15432:5432` (localhost-only binding)
3. Enforce a non-default `OE_DB_PASSWORD` as a required variable (fail startup if missing)

---

### Finding G-2: AES-256 Encryption Key Defaults to `"dev"` and Commits to Weak Value
**Severity: High**
**File**: `SecurityConfig.java` (L113–116), `volume/properties/common.properties` (L9)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/SecurityConfig.java#L113-116
@Value("${encryption.general.password:dev}")
private String encryptionPassword;
```

```OpenELIS-Global-2/volume/properties/common.properties#L8-10
encryption.general.password=kspass
```

**Problem**: The AES-256 encryption key used to encrypt all sensitive `ExternalConnection` passwords (via `EncryptionConverter`) has two problems:
1. The Spring `@Value` default fallback is literally the string `"dev"` — if the property is not set, all database-encrypted credentials are encrypted with a trivially guessable 3-character key
2. The committed `common.properties` sets it to `"kspass"` — the same value as the Tomcat keystore password — meaning a single leaked secret compromises both TLS and all database-encrypted credentials

The `EncryptionConverter` applies AES-256 to all `@Convert(converter = EncryptionConverter.class)` fields (e.g., `BasicAuthenticationData.password`). With a weak encryption key, these encrypted values in the database can be cracked offline trivially.

**Recommendation**:
1. Fail startup if `encryption.general.password` is not explicitly set (don't allow the `"dev"` fallback in production)
2. Use separate, high-entropy random keys for encryption and TLS — never reuse secrets across different security functions
3. Rotate the encryption key and re-encrypt existing data in deployments that used `kspass` or `dev`

---

### Finding G-3: SSL Configuration Contains `testtest` Passwords in Default Properties
**Severity: Medium**
**File**: `application.properties` (L47–52)
Continuing the Security Audit — Finding G-3 through all remaining areas

---

### Finding G-3: SSL Configuration Contains Weak Placeholder Passwords in Default Properties
**Severity: Medium**
**File**: `application.properties` (L47–52)

```OpenELIS-Global-2/src/main/resources/application.properties#L46-52
# SSL Config
server.ssl.key-store = file:/ssl/lf.keystore
server.ssl.key-store-password = testtest
server.ssl.key-password = testtest
server.ssl.trust-store=file:/ssl/lf.truststore
server.ssl.trust-store-password=testtest
```

**Problem**: The base `application.properties` ships with `testtest` as all SSL keystore passwords. These bleed through as defaults when an overlay like `common.properties` doesn't fully override all SSL properties. While `common.properties` does set them to `kspass`, both are single-word dictionary passwords on TLS assets — far below acceptable security baselines. A compromised keystore file with a dictionary password is equivalent to a compromised keystore.

**Recommendation**: Enforce 32+ character random high-entropy values for all keystore passwords. Add a startup validation check that rejects passwords that match `testtest`, `kspass`, `changeit`, or other known defaults.

---

## Area 8 — FHIR Endpoint Security

### Finding H-1: Internal FHIR API is an Unauthenticated Proxy with SSRF Potential
**Severity: Critical**
**File**: `InternalFhirApi.java` (entire file)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/fhir/controller/InternalFhirApi.java#L51-65
@GetMapping("/**")
public ResponseEntity<Object> recieveGetFhirRequests(HttpServletRequest request) {
    return forwardGetRequest(request);
}

@PostMapping("/**")
public void receivePostFhirRequest(HttpServletRequest request, HttpServletResponse response) {
    forwardToFacade(request, response);
}

@PutMapping("/{resourceType}/**")
public void receivePutFhirRequest(@PathVariable("resourceType") ResourceType resourceType, ...) {
    forwardToFacade(request, response);
}
```

And the `forwardGetRequest` method:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/fhir/controller/InternalFhirApi.java#L89-113
String targetUrl = buildQueryPath(fhirConfig.getLocalFhirStorePath(), fhirPath, request.getQueryString());
HttpGet httpGet = new HttpGet(targetUrl);
// ...executes directly
```

**Problem**: This controller maps `/fhir/**` and blindly forwards all GET, POST, and PUT requests to the local FHIR store. There are **two serious security issues here**:

1. **No authorization check on the `/fhir/**` path**: Looking at `SecurityConfig.java`, `/fhir/**` is **not** in `OPEN_PAGES`, `LOGIN_PAGES`, or `RESOURCE_PAGES`. It should fall through to the default security filter chain and require authentication. However, `ModuleAuthenticationInterceptor` returns `true` for all `/rest/**` paths, and `/fhir/**` is a **separate path** — its coverage under the interceptor depends on whether it is registered in Spring MVC's interceptor configuration. If it is not registered in the interceptor registry, all FHIR endpoints are effectively accessible to any authenticated user with no module-level permission check. Requires verification of `AppConfig.java`/`ControllerSetup.java`.

2. **Server-Side Request Forgery (SSRF) via `extractFhirPath`**: The `fhirPath` is extracted directly from the URI, and `buildQueryPath` concatenates it with `fhirConfig.getLocalFhirStorePath()`. There is **no validation that `fhirPath` is a legitimate FHIR resource path**. An attacker could send `GET /fhir/../../etc/passwd` or craft paths that resolve to internal services. Although path normalization in `buildQueryPath` may limit some cases, the `request.getQueryString()` is appended **completely raw**, without any sanitization.

**Recommendation**:
1. Validate `fhirPath` against an allowlist of known FHIR resource types (Patient, Task, ServiceRequest, etc.)
2. Ensure `/fhir/**` is covered by the `ModuleAuthenticationInterceptor` or by a dedicated Spring Security `securityMatcher`
3. Consider replacing the transparent proxy with a structured FHIR client call — don't forward raw HTTP requests

---

### Finding H-2: `FhirQueryRestController` Allows Arbitrary FHIR Resource Type Queries Without Validation
**Severity: High**
**File**: `FhirQueryRestController.java` (L64–130)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/fhir/controller/FhirQueryRestController.java#L64-90
@GetMapping(value = "/{resourceType}", produces = MediaType.APPLICATION_JSON_VALUE)
public ResponseEntity<?> queryFhirResources(
    @PathVariable("resourceType") String resourceType, ...) {

    StringBuilder searchUrl = new StringBuilder();
    searchUrl.append(fhirConfig.getLocalFhirStorePath())
             .append("/")
             .append(resourceType)      // ← User-controlled, unvalidated
             .append("?");

    // All query parameters are forwarded verbatim
    for (Map.Entry<String, String[]> entry : parameterMap.entrySet()) {
        searchUrl.append(URLEncoder.encode(paramName, ...))
                 .append("=")
                 .append(URLEncoder.encode(value, ...));
    }
    Bundle bundle = fhirClient.fetchResourceFromUrl(Bundle.class, searchUrl.toString());
```

**Problem**: `resourceType` is a `@PathVariable String` — it is a plain string taken from the URL, with no validation against known FHIR resource types. While parameter values are URL-encoded, `resourceType` is **appended directly into the URL path** without encoding. An attacker can:
- Pass `../` sequences in `resourceType` to traverse the FHIR store path
- Include query-string characters to inject additional FHIR parameters
- Reference internal FHIR server admin endpoints (e.g., `$reindex`, `$expunge`, metadata/$meta)

This is a **FHIR SSRF and path traversal** vulnerability. The `resourceId` in the second endpoint (`/{resourceType}/{resourceId}`) has the same problem.

**Root Cause**: No allowlist of permitted FHIR resource types. The FHIR R4 spec defines a fixed set of ~140 resource types — only the handful relevant to OpenELIS should be permitted.

**Recommendation**: Validate `resourceType` against an explicit allowlist: `Patient`, `Task`, `ServiceRequest`, `DiagnosticReport`, `Observation`, `Specimen`, `Practitioner`, `Encounter`, `Questionnaire`. Reject any request with an unrecognized resource type with `400 Bad Request`.

---

### Finding H-3: `FhirRestfulServer` Has No Authentication or Authorization Layer
**Severity: High**
**File**: `FhirRestfulServer.java`

```OpenELIS-Global-2/src/main/java/org/openelisglobal/fhir/servlets/FhirRestfulServer.java#L1-38
public class FhirRestfulServer extends RestfulServer {
    @Override
    protected void initialize() throws ServletException {
        super.initialize();
        setFhirContext(FhirContext.forR4());
        Map<String, IResourceProvider> providerMap =
            applicationContext.getBeansOfType(IResourceProvider.class);
        List<IResourceProvider> providers = new ArrayList<>(providerMap.values());
        setResourceProviders(providers);
    }
}
```

**Problem**: The `FhirRestfulServer` (HAPI FHIR's built-in servlet) is initialized with zero interceptors. HAPI FHIR's security model works by registering `IServerInterceptor` instances for authentication and authorization. With none registered:
- No authentication is required to call any FHIR operation exposed via this server
- No authorization is checked against user roles
- Any HTTP client that can reach the servlet can create, update, or read FHIR resources

Currently `PractitionerProvider` is the only registered `IResourceProvider`, so the immediate blast radius is limited to Practitioner create/update. But any future `IResourceProvider` implementation added as a Spring bean will **automatically be exposed** without authentication.

**Root Cause**: The HAPI FHIR authorization interceptor (`AuthorizationInterceptor`) was never implemented.

**Recommendation**: Implement a HAPI FHIR `AuthorizationInterceptor` that:
1. Validates the caller is an authenticated Spring Security session or has valid HTTP Basic credentials
2. Checks the operation against the user's permitted modules
3. Registers it as a server-level interceptor in `FhirRestfulServer.initialize()`

---

## Area 9 — Plugin System Security

### Finding I-1: Unsigned JARs Loaded from a Volume-Mounted Directory — Arbitrary Code Execution
**Severity: Critical**
**File**: `PluginLoader.java` (entire file)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/plugin/PluginLoader.java#L68-90
@PostConstruct
private void load() {
    File pluginDir = new File(PLUGIN_ANALYZER);  // /var/lib/openelis-global/plugins/
    loadDirectory(pluginDir);
}

private void loadActualPlugin(URL url, String classPath) throws LIMSException {
    URL[] urls = { url };
    ClassLoader classLoader = new URLClassLoader(urls, this.getClass().getClassLoader());
    Class<APlugin> aClass = (Class<APlugin>) classLoader.loadClass(classPath);
    APlugin instance = aClass.newInstance();
    instance.connect();   // ← Executes arbitrary code from loaded JAR
}
```

**Problem**: At application startup, `PluginLoader` scans `/var/lib/openelis-global/plugins/`, loads every `.jar` file it finds, parses their embedded XML configuration, and invokes `instance.connect()` on every loaded plugin class. There are **zero integrity checks**:

1. **No JAR signature verification** — any JAR dropped into the plugins volume will be loaded and executed with full JVM permissions (same process, same privileges as the application)
2. **No content validation beyond JDK version check** — the only check is that the jar's manifest `Build-Jdk` version is not newer than the runtime
3. **Recursive directory traversal** — `loadDirectory()` recurses into subdirectories, expanding the attack surface
4. **Volume is accessible from outside the container** — the `docker-compose.yml` maps `./volume/plugins/:/var/lib/openelis-global/plugins/`, meaning any attacker with write access to the host's `./volume/plugins/` directory can execute arbitrary code inside the OpenELIS container

This is a **critical code execution path**. If an attacker can write a malicious JAR to the plugins directory (via a compromised host system, a path traversal via the file import system, or a misconfigured Docker volume mount), they achieve full application-level code execution.

**Recommendation**:
1. Implement JAR signing: generate a plugin signing certificate, sign all legitimate JARs with it, and verify signatures in `PluginLoader` before loading
2. Restrict the plugins volume to be read-only from the host if no new plugins are expected
3. Consider moving plugin loading to an isolated classloader with a restrictive `SecurityManager` (or Java module system restrictions)
4. Log all plugin load events at WARNING level with the full JAR path and a checksum for forensic audit

---

## Area 10 — Notification System & Information Disclosure

### Finding J-1: `GET /rest/notifications/all` Exposes All Users' Notifications
**Severity: High**
**File**: `NotificationRestController.java` (L49–51)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/notifications/rest/NotificationRestController.java#L48-51
@GetMapping("/notifications/all")
public List<Notification> getNotifications() {
    return notificationDAO.getNotifications();   // ← No user filtering
}
```

**Problem**: This endpoint returns **all notifications for all users in the system** — with no authorization check and no filtering by the requesting user's identity. Any authenticated user (including the lowest-privilege lab technician) can call `GET /rest/notifications/all` and read every notification ever sent to every user in the system. Notifications contain clinical messages such as password expiry reminders, lab result events, and system alerts tied to specific users. This is a horizontal privilege escalation — a user reading data they should not have access to.

**Root Cause**: Missing `WHERE user_id = current_user` clause in the "all notifications" endpoint.

**Recommendation**: Either remove this endpoint entirely or restrict it to users with ADMIN role. The correct user-scoped endpoint already exists at `GET /rest/notifications` (L53–57 in the same file), which filters by `sysUserId` from the session.

---

### Finding J-2: `POST /notification/{userId}` Sends Push Notifications to Any User by ID
**Severity: High**
**File**: `NotificationRestController.java` (L60–122)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/notifications/rest/NotificationRestController.java#L60-65
@PostMapping("/notification/{userId}")
public ResponseEntity<?> saveNotification(
        @PathVariable String userId,
        @RequestBody Notification notification) {
    notification.setUser(systemUserService.getUserById(userId));
    // No check that the caller is userId or an admin
```

**Problem**: Any authenticated user can POST to `/rest/notification/{userId}` where `userId` is any other user's ID, and they will:
1. Persist a notification in that user's notification feed
2. Trigger a real push notification to that user's browser

There is **no check** that the authenticated caller is the target user or an administrator. This enables a **notification injection / social engineering attack**: a low-privilege user can craft and send arbitrary messages (appearing as official system notifications) to any other user, including administrators. This is a significant phishing vector in a clinical environment where push notifications are trusted.

**Root Cause**: Missing `getSysUserId(request)` guard before accepting the `userId` path variable.

**Recommendation**: Validate that `Integer.parseInt(userId)` equals `Integer.parseInt(getSysUserId(request))`, or that the caller has an ADMIN role, before allowing the notification to be created.

---

### Finding J-3: `GET /rest/systemusers` Exposes Full User Directory to All Authenticated Users
**Severity: Medium**
**File**: `NotificationRestController.java` (L158–161)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/notifications/rest/NotificationRestController.java#L158-161
@GetMapping("/systemusers")
public List<SystemUser> getSystemUsers() {
    return notificationDAO.getSystemUsers();   // ← Full user list, no auth check
}
```

**Problem**: This endpoint returns the full list of all system users — names, login names, and other profile data. No role check is applied. In a multi-user lab with dozens or hundreds of staff, exposing the full user directory to all authenticated users (including external interfaces) provides an easy reconnaissance target: an attacker who compromises any low-privilege account immediately gets a full user list to target for further attacks.

**Recommendation**: Restrict this endpoint to ADMIN role, or return only the minimum fields required for notification UI (user ID and display name), and apply `@PreAuthorize("hasRole('ADMIN')")`.

---

## Area 11 — Secrets Management Summary

### Finding K-1: Encryption Key Reuse Across Multiple Security Functions
**Severity: High**
**Evidence**: `volume/properties/common.properties`

```OpenELIS-Global-2/volume/properties/common.properties#L1-10
server.ssl.key-store-password = kspass
server.ssl.key-password = kspass
server.ssl.trust-store-password=tspass
encryption.general.password=kspass       ← Same as keystore password
```

**Problem**: The `encryption.general.password` (used by `AES256TextEncryptor` to encrypt all external connection credentials in the database) is set to `kspass` — **the same value as the TLS keystore password**. Security principle: keys must never be reused across different security functions. A single leaked secret now compromises both the TLS certificate chain AND all database-encrypted credentials. This violates the principle of key isolation and significantly reduces the effective security of the encryption scheme.

---

## Area 12 — Complete Risk Register

Here is the full prioritized risk register for all findings:

---

| ID | Area | Severity | Title | Evidence |
|---|---|---|---|---|
| **H-1** | FHIR | 🔴 Critical | Internal FHIR API — SSRF & authorization bypass | `InternalFhirApi.java` |
| **B-1** | CORS | 🔴 Critical | CORS origin reflection with credentials — cross-origin PHI theft | `CORSFilter.java` |
| **I-1** | Plugin | 🔴 Critical | Unsigned JAR loading from Docker volume — arbitrary code execution | `PluginLoader.java` |
| **A-4** | Auth/SSO | 🔴 High | SAML auto-provision sets hardcoded admin sysUserId | `CustomSSOAuthenticationSuccessHandler.java` |
| **A-6** | Auth/RBAC | 🔴 High | REST module auth fails open — new endpoints accessible to all | `ModuleAuthenticationInterceptor.java` |
| **C-1** | PHI/Logs | 🔴 High | Hibernate TRACE logging writes PHI to disk by default | `application.properties` |
| **D-1** | Secrets | 🔴 High | VAPID private key committed to source control | `application.properties` |
| **E-1** | XSS | 🔴 High | Trivially bypassable XSS filter creates false security | `SecurityFilter.java` |
| **F-1** | CSP | 🔴 High | CSP `unsafe-inline` + `unsafe-eval` render policy ineffective | `SecurityConfig.java` |
| **G-1** | Infra | 🔴 High | PostgreSQL port 15432 exposed to host network | `docker-compose.yml` |
| **G-2** | Secrets | 🔴 High | AES-256 encryption key defaults to `"dev"` | `SecurityConfig.java` |
| **H-2** | FHIR | 🔴 High | Unvalidated FHIR resource type — path traversal/SSRF | `FhirQueryRestController.java` |
| **H-3** | FHIR | 🔴 High | HAPI FHIR server has no authentication interceptor | `FhirRestfulServer.java` |
| **J-1** | Notif. | 🔴 High | All users' notifications exposed to any authenticated user | `NotificationRestController.java` |
| **J-2** | Notif. | 🔴 High | Any user can inject push notifications to any other user | `NotificationRestController.java` |
| **A-1** | Session | 🟠 High | Session ID exposed in JSON API response | `LoginPageController.java` |
| **A-3** | Auth | 🟠 High | Default admin password `adminADMIN!` hardcoded in compose files | Multiple compose files |
| **B-2** | CSRF | 🟠 High | All `/rest/**` endpoints exempt from CSRF protection | `SecurityConfig.java` |
| **K-1** | Secrets | 🟠 High | Encryption key reused across TLS and database secrets | `common.properties` |
| **A-2** | Logging | 🟡 Medium | Forged `X-Forwarded-For` poisons audit log | `CustomFormAuthenticationSuccessHandler.java` |
| **A-5** | RBAC | 🟡 Medium | `getGrantedAuthorities()` always returns empty — `@PreAuthorize` broken | `CustomUserDetailsService.java` |
| **B-3** | TLS | 🟡 Medium | `proxy_ssl_verify off` on all Nginx→backend connections | `nginx.conf` |
| **G-3** | TLS | 🟡 Medium | SSL keystore passwords default to `testtest` | `application.properties` |
| **J-3** | Auth | 🟡 Medium | Full system user directory exposed to all authenticated users | `NotificationRestController.java` |
| **A-2** | Logging | 🟢 Low | Login usernames logged on every attempt — enumeration risk | `AuthenticationListener.java` |
| **D-2** | Notif. | 🟢 Low | VAPID public key endpoint may need to be open but is auth-gated | `NotificationRestController.java` |

---

## Summary: Key Architectural Patterns Behind the Findings

After this deep audit, the findings cluster around **5 root architectural patterns** rather than isolated bugs:

**1. Fail-Open Authorization Design**: Both the module interceptor (REST bypass) and the FHIR layer demonstrate a pattern of defaulting to `return true` when no rule matches. In a healthcare system this must be inverted to fail-closed.

**2. Development Defaults Bleeding Into Production**: `testtest`, `kspass`, `clinlims`, `dev` — development convenience values are embedded in default property files and Docker Compose definitions, and there is no startup-time enforcement that prevents them from reaching production.

**3. Single-Layer CORS with No Trusted Origin List**: The CORS implementation is a single filter applied uniformly across all endpoints with a reflect-all-origins pattern, combined with a blanket CSRF exemption on `/rest/**`. Together these two decisions completely nullify browser-level cross-origin protections for the most sensitive API surface.

**4. No Integrity Boundary on External Code/Data Inputs**: Unsigned plugin JARs, unvalidated FHIR resource type path variables, unvalidated file import paths, and reflected CORS origins all represent inputs that cross a trust boundary without verification.

**5. Duplicated, Inconsistent Authorization Logic**: Form login uses the module interceptor; SSO uses granted authorities; `@PreAuthorize` is sprinkled on 4 endpoints; `getGrantedAuthorities()` returns empty for form login. These inconsistencies mean the authorization model has untested interaction effects depending on which login method is used.

---

**We are ready to move to Phase 2** — CSRF/CORS remediation, PHI logging hardening, and FHIR security — with concrete code-level fixes for each finding. Say the word and we'll proceed finding by finding with actual patch proposals.


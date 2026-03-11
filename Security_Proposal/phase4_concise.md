# Phase 4 Security Audit — FHIR Endpoint Security (Concise)

OpenELIS exposes FHIR through five independently routed surfaces. **None carries any authorization guard.**

| Surface | Path | Class |
|---------|------|-------|
| FHIR Query Proxy | `/rest/fhir/**` | `FhirQueryRestController` |
| Internal Passthrough | `/fhir/**` | `InternalFhirApi` |
| HAPI Facade Servlet | `/fhir/facade/*` | `FhirRestfulServer` |
| Transformation Trigger | `/OEToFhir`, `/PatientToFhir` | `FhirTransformationController` |
| Export / Admin Actions | `/dataexport/fhir`, `/fhir/optimizeStorage` | `FhirExportController`, `FhirActionController` |

---

## P4-A: `FhirQueryRestController` — Arbitrary Resource Type, Unfiltered Params, No Auth

**Severity:** Critical | **File:** `FhirQueryRestController.java` (L59–315)

Four handler variants share the same root problem: `{resourceType}` is a raw path variable appended directly into the FHIR store URL, and every HTTP parameter from the caller is forwarded verbatim.

**P4-A1 — `GET /{resourceType}`**

```java
searchUrl.append(fhirConfig.getLocalFhirStorePath())
         .append("/").append(resourceType)   // ← unvalidated
         .append("?");
for (Map.Entry<String, String[]> entry : request.getParameterMap().entrySet()) {
    searchUrl.append(encode(paramName)).append("=").append(encode(value)); // ← all params
}
Bundle bundle = fhirClient.fetchResourceFromUrl(Bundle.class, searchUrl.toString());
```

Any authenticated user can query `Patient`, `DiagnosticReport`, `Observation`, or any other FHIR type. FHIR traversal operators (`_include`, `_revinclude`, `_everything`) are honoured without restriction because all parameters pass through.

**P4-A2 — `GET /{resourceType}/{resourceId}`**

```java
IBaseResource resource = fhirClient.read()
    .resource(resourceType)   // ← unvalidated type
    .withId(resourceId)       // ← unvalidated ID
    .execute();
```

Any resource in the FHIR store is readable by supplying its type and ID. No ownership check, no role gate.

**P4-A3 — `POST /{resourceType}/_search`**

The entire request body (`Map<String, Object> searchParams`) is URL-encoded and forwarded. An attacker can inject FHIR parameters the UI never exposes (`_query`, `_filter`, store-specific operators).

**P4-A4 — `GET /{resourceType}/_search`**

Unlike P4-A1, this variant skips *no* parameters — `count`, `includeTotal`, and any injected FHIR operator all pass straight through.

**Patch:**

```java
// Add at class level
private static final Set<String> ALLOWED_RESOURCE_TYPES = Set.of(
    "Patient", "ServiceRequest", "DiagnosticReport", "Observation",
    "Practitioner", "Organization", "Specimen", "Task", "QuestionnaireResponse"
);
private static final Set<String> ALLOWED_PARAMS = Set.of(
    "_id", "_lastUpdated", "identifier", "subject", "patient",
    "status", "date", "name", "birthdate", "_count", "_sort", "_include"
);

// Add at the top of every handler
@PreAuthorize("hasAnyRole('ROLE_RESULTS','ROLE_VALIDATION','ROLE_GLOBAL_ADMIN')")
public ResponseEntity<?> queryFhirResources(@PathVariable String resourceType, ...) {
    if (!ALLOWED_RESOURCE_TYPES.contains(resourceType)) {
        return ResponseEntity.status(HttpStatus.FORBIDDEN)
                .body(Map.of("error", "Resource type not permitted"));
    }
    // Replace verbatim param loop with filtered version:
    for (Map.Entry<String, String[]> entry : request.getParameterMap().entrySet()) {
        if (!ALLOWED_PARAMS.contains(entry.getKey())) continue;
        // ... append to searchUrl
    }
}
```

Apply `ALLOWED_RESOURCE_TYPES` and `ALLOWED_PARAMS` checks to all four handler variants. Validate `resourceId` with `resourceId.matches("[a-zA-Z0-9\\-]{1,64}")`.

---

## P4-B: `InternalFhirApi` — Wildcard Proxy, No Path Normalization, SSRF

**Severity:** Critical | **File:** `InternalFhirApi.java` (L51–143)

`@GetMapping("/**")` and `@PostMapping("/**")` accept any path under `/fhir/` and forward it to the local FHIR store. `extractFhirPath` does a simple string replace of `/fhir` from the URI — no `..` prevention, no allowlist, no sanitization. The query string is appended completely raw.

```java
String fhirPath = extractFhirPath(request);  // just strips "/fhir" prefix
String targetUrl = buildQueryPath(
    fhirConfig.getLocalFhirStorePath(), fhirPath, request.getQueryString());
HttpGet httpGet = new HttpGet(targetUrl);     // raw HTTP to FHIR store
```

A crafted path like `/fhir/../../internal-admin` can reach any path on the FHIR store host — a full SSRF proxy. The `forwardToFacade` POST/PUT path has the same issue via `RequestDispatcher.forward()`.

**Patch:**

```java
// Gate to admin, add path normalization, reject traversal
@PreAuthorize("hasRole('ROLE_GLOBAL_ADMIN')")
@GetMapping("/**")
public ResponseEntity<Object> recieveGetFhirRequests(HttpServletRequest request) {
    String fhirPath = sanitizeFhirPath(extractFhirPath(request));
    return forwardGetRequest(fhirPath, request.getQueryString());
}

private String sanitizeFhirPath(String path) {
    String normalized = URI.create(path).normalize().toString();
    if (normalized.contains("..")) {
        throw new IllegalArgumentException("Path traversal rejected");
    }
    // Validate first segment is an allowed FHIR resource type
    String[] segments = normalized.split("/");
    if (segments.length > 1 && !ALLOWED_RESOURCE_TYPES.contains(segments[1])) {
        throw new IllegalArgumentException("Resource type not permitted");
    }
    return normalized;
}
```

Long-term, remove the wildcard proxy entirely. Replace with typed HAPI FHIR client calls (`fhirClient.read().resource(type).withId(id).execute()`) so arbitrary paths cannot be constructed.

---

## P4-C: `FhirRestfulServer` — No `IAuthorizationInterceptor`, Outside Spring Security

**Severity:** Critical | **Files:** `FhirRestfulServer.java`, `AnnotationWebAppInitializer.java` (L35)

The HAPI servlet is registered as a raw Java servlet at `/fhir/facade/*`, bypassing Spring Security's filter chain entirely. It initializes with zero interceptors.

```java
// AnnotationWebAppInitializer.java
ServletRegistration.Dynamic fhirServlet = servletContext.addServlet("FhirServlet",
        new FhirRestfulServer(rootContext));
fhirServlet.addMapping("/fhir/facade/*");  // Spring Security does not cover this

// FhirRestfulServer.java — no interceptors registered
protected void initialize() throws ServletException {
    setFhirContext(FhirContext.forR4());
    setResourceProviders(new ArrayList<>(providerMap.values()));
    // ← IAuthorizationInterceptor never registered
}
```

Any unauthenticated client that knows the path can call HAPI operations directly.

**Patch:**

```java
// FhirRestfulServer.java
protected void initialize() throws ServletException {
    setFhirContext(FhirContext.forR4());
    registerInterceptor(new OpenElisAuthorizationInterceptor()); // ADD — before providers
    setResourceProviders(new ArrayList<>(providerMap.values()));
}

// OpenElisAuthorizationInterceptor.java
public class OpenElisAuthorizationInterceptor extends AuthorizationInterceptor {
    @Override
    public List<IAuthRule> buildRuleList(RequestDetails theRequestDetails) {
        HttpServletRequest req = (HttpServletRequest) theRequestDetails.getServletRequest();
        HttpSession session = req.getSession(false);
        if (session == null ||
                session.getAttribute(IActionConstants.USER_SESSION_DATA) == null) {
            return new RuleBuilder().denyAll("No active session").build();
        }
        return new RuleBuilder()
            .allow().read().resourcesOfType(Practitioner.class).withAnyId().andThen()
            .allow().write().resourcesOfType(Practitioner.class).withAnyId().andThen()
            .denyAll("Default deny")
            .build();
    }
}
```

Also map `DelegatingFilterProxy` to `/fhir/facade/*` in `AnnotationWebAppInitializer` so the Spring Security chain applies at the servlet boundary as a second layer.

---

## P4-D: Transformation and Export Triggers — DoS / PHI Exfiltration, No Auth

**Severity:** Critical | **Files:** `FhirTransformationController.java`, `FhirExportController.java`

**P4-D1 — `/PatientToFhir` and `/OEToFhir`**

Any authenticated user can trigger mass transformation of all patients with arbitrary thread counts and batch sizes:

```java
@GetMapping("/PatientToFhir")
public TransformationInfo transformPersistFhirPatients(
        @RequestParam(defaultValue = "false") Boolean checkAll,
        @RequestParam(defaultValue = "100") int batchSize,
        @RequestParam(defaultValue = "1")   int threads, ...) {
    if (info.checkAll) {
        patients = sampleHumanService.getAllPatientsWithSampleEntered(); // entire DB
    }
    promises.add(fhirTransformService.transformPersistPatients(patientIds));
```

`checkAll=true&threads=100` fires 100 async threads processing the entire patient database — a DoS and a forced PHI sync to all configured remote FHIR stores.

**P4-D2 — `/OEToFhir/info`**

Returns `TransformationInfo` (batch count, size, state) with no auth. Reveals approximate database record count via `batches * batchSize`.

**P4-D3 — `/dataexport/fhir`**

```java
@PostMapping
public void runAllDataExportTasks() {
    for (DataExportTask task : dataExportTaskService.getDAO().findAll()) {
        dataExportService.exportNewDataFromLocalToRemote(task); // pushes all PHI
    }
}
```

Any authenticated user triggers immediate export of all pending data to all remote FHIR servers. No rate limit. No audit entry linking it to the requesting user.

**Patch:**

```java
// Gate all three endpoints with a single class-level annotation
@RestController
@PreAuthorize("hasRole('ROLE_GLOBAL_ADMIN')")
public class FhirTransformationController extends BaseController {

    @GetMapping("/PatientToFhir")
    public TransformationInfo transformPersistFhirPatients(
            @RequestParam(defaultValue = "false") Boolean checkAll,
            @RequestParam(defaultValue = "100") int batchSize,
            @RequestParam(defaultValue = "1")   int threads, ...) {
        // Cap parameters to prevent thread exhaustion
        batchSize = Math.min(batchSize, 500);
        threads   = Math.min(threads, 4);
        ...
    }
}

// Same for FhirExportController
@PreAuthorize("hasRole('ROLE_GLOBAL_ADMIN')")
public class FhirExportController { ... }
```

---

## P4-E: `/fhir/optimizeStorage` — Admin FHIR Op, No Auth, Repeatable DoS

**Severity:** High | **File:** `FhirActionController.java` (L26)

Triggers `$reindex` (ALL_VERSIONS) on the local FHIR store. No role check. Invoking it repeatedly stalls FHIR query performance indefinitely.

```java
@PostMapping("/fhir/optimizeStorage")
public ResponseEntity<String> triggerOptimizeStorage() throws ... {
    HttpPost httpPost = new HttpPost(fhirConfig.getLocalFhirStorePath() + "/$reindex");
    // ... no auth guard, no cooldown
}
```

**Patch:**

```java
@PreAuthorize("hasRole('ROLE_GLOBAL_ADMIN')")
@PostMapping("/fhir/optimizeStorage")
public ResponseEntity<String> triggerOptimizeStorage() throws ... {
    if (Duration.between(lastReindexTime, Instant.now()).compareTo(REINDEX_COOLDOWN) < 0) {
        return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
                .body("Reindex cooldown active. Retry after " + REINDEX_COOLDOWN.toMinutes() + " min.");
    }
    lastReindexTime = Instant.now();
    // ... proceed
}

private static volatile Instant lastReindexTime = Instant.EPOCH;
private static final Duration REINDEX_COOLDOWN  = Duration.ofMinutes(30);
```

---

## P4-F: External Patient Search — `ALLOW_ALL_HOSTNAME_VERIFIER` + Credentials in URL

**Severity:** Critical | **File:** `ExternalPatientSearch.java` (L185, L299)

TLS hostname verification is explicitly disabled — the code even carries a `TODO` acknowledging it:

```java
// TODO shouldn't let a self signed cert through
SSLSocketFactory sslsf = new SSLSocketFactory(new TrustSelfSignedStrategy(),
        SSLSocketFactory.ALLOW_ALL_HOSTNAME_VERIFIER); // ← MitM open door
```

Credentials are placed in the URL query string:

```java
uriFinal = new URIBuilder(uriStart)
    .addParameter(GET_PARAM_NAME, connectionName)      // username in URL
    .addParameter(GET_PARAM_PWD, connectionPassword)   // password in URL
    .build();
```

URL-embedded credentials appear in server access logs, browser history, referrer headers, and proxy logs on both ends.

**Patch:**

```java
// Replace ALLOW_ALL_HOSTNAME_VERIFIER with the shared HttpClient that uses the
// application trust store (already configured in HttpClientConfig):
// @Autowired CloseableHttpClient httpClient; — inject instead of building ad hoc

// Remove credential params from URIBuilder — move to Authorization header:
String encoding = Base64.getEncoder().encodeToString(
        (connectionName + ":" + connectionPassword).getBytes(StandardCharsets.UTF_8));
httpGet.setHeader(HttpHeaders.AUTHORIZATION, "Basic " + encoding);
// Remove these two lines from URIBuilder:
// .addParameter(GET_PARAM_NAME, connectionName)
// .addParameter(GET_PARAM_PWD, connectionPassword)
```

---

## P4-G: FHIR BasicAuth Over Potential HTTP Connections

**Severity:** High | **File:** `FhirUtil.java` (L33)

`BasicAuthInterceptor` attaches `Authorization: Basic <base64>` on every FHIR client request. There is no check that the FHIR store URL uses HTTPS before attaching credentials. If `org.openelisglobal.fhirstore.uri` is ever set to `http://` in any environment, credentials travel in cleartext.

```java
IClientInterceptor authInterceptor = new BasicAuthInterceptor(
        fhirConfig.getUsername(), fhirConfig.getPassword());
fhirClient.registerInterceptor(authInterceptor); // no HTTPS guard
```

**Patch:**

```java
if (!GenericValidator.isBlankOrNull(fhirConfig.getUsername())) {
    if (!fhirStorePath.startsWith("https://")) {
        throw new IllegalStateException(
            "FHIR store path must use HTTPS when credentials are configured. " +
            "Got: " + fhirStorePath);
    }
    fhirClient.registerInterceptor(
        new BasicAuthInterceptor(fhirConfig.getUsername(), fhirConfig.getPassword()));
}
```

Apply the same guard in `getLocalFhirClient()` and any call site using remote store credentials.

---

## P4-H: `FhirConfig` — Credential Fields Have Public `@Getter`

**Severity:** High | **File:** `FhirConfig.java` (L43–56)

All four credential fields (`fhirstore.username`, `fhirstore.password`, `crserver.username`, `crserver.password`) carry Lombok `@Getter`, making them accessible to any Spring bean holding a `FhirConfig` reference. If any logging framework or serialization path processes `FhirConfig`, all four values appear in plaintext.

```java
@Getter  // ← any bean can call fhirConfig.getPassword()
@Value("${org.openelisglobal.fhirstore.password:}")
private String password;
```

**Patch:**

```java
// Remove @Getter from all credential fields
@Value("${org.openelisglobal.fhirstore.password:}")
private String password;  // no public getter

// Expose credentials only through a package-scoped factory method
// so usage is centralized and auditable:
BasicAuthInterceptor newLocalStoreAuthInterceptor() {
    return new BasicAuthInterceptor(username, password);
}
```

This prevents `fhirConfig.getPassword()` from being callable outside the `fhir` package, centralizing all credential access in `FhirConfig` itself.

---

## P4-I: `FhirRestfulServer` Auto-Discovers All `IResourceProvider` Beans

**Severity:** High | **File:** `FhirRestfulServer.java` (L21)

```java
Map<String, IResourceProvider> providerMap =
        applicationContext.getBeansOfType(IResourceProvider.class);
setResourceProviders(new ArrayList<>(providerMap.values())); // all beans, no gate
```

Every future `@Component` implementing `IResourceProvider` is automatically registered and exposed as a FHIR endpoint. A developer who adds a new provider without explicit authorization logic instantly ships a new unguarded FHIR surface.

**Patch:**

```java
// Replace auto-discovery with an explicit registration list
protected void initialize() throws ServletException {
    setFhirContext(FhirContext.forR4());
    registerInterceptor(applicationContext.getBean(OpenElisAuthorizationInterceptor.class));

    // Each provider must be deliberately listed here after security review
    List<IResourceProvider> providers = List.of(
        applicationContext.getBean(PractitionerProvider.class)
        // Add future providers here intentionally
    );
    setResourceProviders(providers);
}
```

---

## P4-J: No FHIR Audit Trail for Any Data Access

**Severity:** High | **All five FHIR surfaces**

No FHIR read, write, or search operation across any of the five surfaces is logged to the audit trail. Reads via `FhirQueryRestController`, bulk transforms via `/OEToFhir`, and exports via `/dataexport/fhir` are completely invisible in logs. A data breach via the FHIR surface leaves no forensic evidence — a direct ISO 15189 / SLIPTA non-repudiation failure.

**Patch:**

```java
@Component
public class FhirAccessAuditInterceptor extends InterceptorAdapter {

    @Autowired
    private HistoryService historyService;

    @Hook(Pointcut.SERVER_OUTGOING_RESPONSE)
    public void auditFhirAccess(RequestDetails requestDetails,
                                 IBaseResource responseResource) {
        String resourceType = requestDetails.getResourceName();
        String resourceId   = requestDetails.getId() != null
                              ? requestDetails.getId().getIdPart() : "search";
        String userId = extractSessionUserId(requestDetails);

        LogEvent.logInfo("FhirAudit", "access",
            "FHIR " + requestDetails.getRequestType()
            + " " + resourceType + "/" + resourceId
            + " by userId=" + userId);

        historyService.recordFhirAccess(
            userId, resourceType, resourceId,
            requestDetails.getRequestType().name());
    }
}
```

Register alongside `OpenElisAuthorizationInterceptor` in `FhirRestfulServer.initialize()`.

---

## Risk Register — Phase 4

| ID | Finding | Severity |
|----|---------|---------|
| P4-A1 | `GET /{resourceType}` — arbitrary type, all params forwarded, no auth | 🔴 Critical |
| P4-A2 | `GET /{resourceType}/{resourceId}` — unguarded full-store read | 🔴 Critical |
| P4-A3 | `POST /_search` — attacker-controlled body forwarded to FHIR store | 🔴 Critical |
| P4-A4 | `GET /_search` — entire query string forwarded, zero filtering | 🔴 Critical |
| P4-B | `InternalFhirApi` wildcard proxy — no path normalization, SSRF | 🔴 Critical |
| P4-C | HAPI servlet outside Spring Security, no `IAuthorizationInterceptor` | 🔴 Critical |
| P4-D1 | `/PatientToFhir`, `/OEToFhir` — bulk PHI transform, DoS, data exfil | 🔴 Critical |
| P4-D3 | `/dataexport/fhir` — triggers all PHI exports to remote servers | 🔴 Critical |
| P4-F | `ALLOW_ALL_HOSTNAME_VERIFIER` + credentials in URL query string | 🔴 Critical |
| P4-D2 | `/OEToFhir/info` — leaks DB record count and processing state | 🟡 Medium |
| P4-E | `/fhir/optimizeStorage` — repeatable `$reindex` DoS, no admin gate | 🟠 High |
| P4-G | `FhirUtil` BasicAuth attached without HTTPS check | 🟠 High |
| P4-H | `FhirConfig` credential fields with public `@Getter` | 🟠 High |
| P4-I | Auto-discovered `IResourceProvider` beans — no registration gate | 🟠 High |
| P4-J | No FHIR audit trail across any surface | 🟠 High |

---

## Remediation Sequence

The order matters because some fixes are prerequisites for others:

1. **P3-I first** — Add `@EnableMethodSecurity(prePostEnabled = true)` to `SecurityConfig`. Without it every `@PreAuthorize` added here is a no-op.
2. **P4-C** — Register `OpenElisAuthorizationInterceptor` on the HAPI servlet and map `DelegatingFilterProxy` to `/fhir/facade/*`.
3. **P4-A** — Add resource type allowlist and parameter allowlist to all four `FhirQueryRestController` handlers.
4. **P4-B** — Add path normalization and admin gate to `InternalFhirApi`; replace raw `HttpGet` with typed HAPI client calls.
5. **P4-D + P4-E** — Gate all transformation, export, and optimize-storage endpoints to `ROLE_GLOBAL_ADMIN`. Cap `threads` and `batchSize`.
6. **P4-F** — Replace `ALLOW_ALL_HOSTNAME_VERIFIER`, move credentials to `Authorization` header.
7. **P4-G + P4-H** — Enforce HTTPS before attaching `BasicAuthInterceptor`; remove `@Getter` from credential fields.
8. **P4-I** — Replace auto-discovery with explicit provider list.
9. **P4-J** — Register `FhirAccessAuditInterceptor` for ISO 15189 non-repudiation coverage.
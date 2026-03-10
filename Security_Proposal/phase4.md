Phase 4 Security Audit — FHIR Endpoint Security

This audit covers the entire FHIR surface of OpenELIS Global 2: the proxy REST controllers, the HAPI `RestfulServer` servlet facade, the data export pipeline, the transformation pipeline, admin actions, the external patient search TLS path, and the client-registry connection. Every finding is anchored to specific files and lines.

---

## Audit Scope — The Five FHIR Surfaces

The codebase exposes FHIR through **five distinct, independently routed surfaces**:

| Surface | Mount Path | Class |
|---|---|---|
| **A. FHIR Query Proxy** | `/rest/fhir/**` | `FhirQueryRestController` |
| **B. Internal FHIR Passthrough** | `/fhir/**` | `InternalFhirApi` |
| **C. HAPI Facade Servlet** | `/fhir/facade/*` | `FhirRestfulServer` |
| **D. Transformation Trigger** | `/OEToFhir`, `/PatientToFhir` | `FhirTransformationController` |
| **E. Export / Admin Actions** | `/dataexport/fhir`, `/fhir/optimizeStorage` | `FhirExportController`, `FhirActionController` |

**None of these five surfaces carry any authorization guard**, as confirmed by absence of `@PreAuthorize`, role checks, or `SecurityConfig` matchers for these paths.

---

## P4-A: FHIR Query Proxy — Arbitrary Resource Type, Full SSRF Vector, No Auth

### P4-A1 — Arbitrary `{resourceType}` with no allowlist

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/fhir/controller/FhirQueryRestController.java#L59-84
@GetMapping(value = "/{resourceType}", produces = MediaType.APPLICATION_JSON_VALUE)
public ResponseEntity<?> queryFhirResources(@PathVariable("resourceType") String resourceType,
        @RequestParam(required = false) Integer count, ..., HttpServletRequest request) {
    ...
    IGenericClient fhirClient = fhirUtil.getLocalFhirClient();

    StringBuilder searchUrl = new StringBuilder();
    searchUrl.append(fhirConfig.getLocalFhirStorePath()).append("/").append(resourceType).append("?");

    // Add ALL query params from the HTTP request, zero filtering
    Map<String, String[]> parameterMap = request.getParameterMap();
    for (Map.Entry<String, String[]> entry : parameterMap.entrySet()) {
        ...
        searchUrl.append(URLEncoder.encode(paramName, ...)).append("=")
                 .append(URLEncoder.encode(value, ...));
    }

    Bundle bundle = (Bundle) fhirClient.fetchResourceFromUrl(Bundle.class, searchUrl.toString());
    return ResponseEntity.ok(bundle);
}
```

**Three compounding problems in one method:**

1. `resourceType` is a raw path variable with no allowlist. Any string accepted — `Patient`, `DiagnosticReport`, `Observation`, `Binary`, `Subscription`, `OperationDefinition`, or a malformed value that reaches the FHIR store.
2. **Every query parameter from the caller's HTTP request** is passed through verbatim after URL-encoding. This means any FHIR search modifier (`_revinclude`, `_include`, `_everything`, `_has`) is honoured without restriction, enabling unbounded data traversal across the FHIR store.
3. The `resourceId` path is concatenated into the FHIR store URL using string append with no path sanitization — a structural SSRF enabler.

### P4-A2 — `/{resourceType}/{resourceId}` — Resource Traversal By ID

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/fhir/controller/FhirQueryRestController.java#L133-165
@GetMapping(value = "/{resourceType}/{resourceId}", produces = MediaType.APPLICATION_JSON_VALUE)
public ResponseEntity<?> getFhirResource(@PathVariable("resourceType") String resourceType,
        @PathVariable("resourceId") String resourceId) {
    ...
    IGenericClient fhirClient = fhirUtil.getLocalFhirClient();
    IBaseResource resource = fhirClient.read().resource(resourceType).withId(resourceId).execute();
    return ResponseEntity.ok(resource);
}
```

`resourceType` and `resourceId` arrive from the caller with no validation. A caller can read **any resource in the local FHIR store** — `Patient/1`, `DiagnosticReport/1`, `Observation/1`, etc. — by supplying the type and ID. This is an unguarded FHIR read-all endpoint.

### P4-A3 — POST `/_search` passes body params directly to FHIR store

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/fhir/controller/FhirQueryRestController.java#L176-260
@PostMapping(value = "/{resourceType}/_search", ...)
public ResponseEntity<?> searchFhirResources(@PathVariable("resourceType") String resourceType,
        @RequestBody(required = false) Map<String, Object> searchParams, ...) {
    ...
    // ALL keys and values from request body appended to URL:
    for (Map.Entry<String, Object> entry : searchParams.entrySet()) {
        searchUrl.append(URLEncoder.encode(paramName, ...)).append("=")
                 .append(URLEncoder.encode(value.toString(), ...));
    }
    Bundle bundle = (Bundle) fhirClient.fetchResourceFromUrl(Bundle.class, searchUrl.toString());
```

A POST body whose keys and values are entirely attacker-controlled is URL-encoded and forwarded to the FHIR store. No parameter name or value filtering occurs. This allows injection of FHIR search parameters that the UI never exposes — e.g., `_query`, `_filter`, or store-specific operation parameters.

### P4-A4 — Raw `/_search` GET passes entire query string with no filtering

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/fhir/controller/FhirQueryRestController.java#L270-315
@GetMapping(value = "/{resourceType}/_search", produces = MediaType.APPLICATION_JSON_VALUE)
public ResponseEntity<?> searchFhirResourcesRaw(..., HttpServletRequest request) {
    ...
    Map<String, String[]> parameterMap = request.getParameterMap();
    for (Map.Entry<String, String[]> entry : parameterMap.entrySet()) {
        // ALL params — including "count" and "includeTotal" — are passed through:
        searchUrl.append(URLEncoder.encode(paramName, ...)).append("=")
                 .append(URLEncoder.encode(value, ...));
    }
    Bundle bundle = (Bundle) fhirClient.fetchResourceFromUrl(Bundle.class, searchUrl.toString());
```

Unlike the `GET /{resourceType}` endpoint which at least skips `count` and `includeTotal`, this `_search` GET variant **skips no parameters at all** — every query string entry, including any injected FHIR parameter, goes straight through.

---

## P4-B: Internal FHIR Passthrough — Wildcard Proxy, No Auth, Path Traversal

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
public void receivePutFhirRequest(@PathVariable("resourceType") ResourceType resourceType,
        HttpServletRequest request, HttpServletResponse response) {
    forwardToFacade(request, response);
}
```

The `GET /**` handler accepts **any path under `/fhir/`** and proxies it to the local FHIR store:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/fhir/controller/InternalFhirApi.java#L87-116
private ResponseEntity<Object> forwardGetRequest(HttpServletRequest request) {
    String fhirPath = extractFhirPath(request);
    String targetUrl = buildQueryPath(fhirConfig.getLocalFhirStorePath(), fhirPath, request.getQueryString());
    HttpGet httpGet = new HttpGet(targetUrl);
    ...
    try (CloseableHttpResponse response = httpClient.execute(httpGet)) {
        ...
        return ResponseEntity.status(statusCode).contentType(MediaType.APPLICATION_JSON).body(json);
    }
}
```

`extractFhirPath` does a simple string replacement of `/fhir` from the request URI — **no path normalization, no `..` traversal prevention, no allowlist**. The `targetUrl` is constructed by concatenating `localFhirStorePath + fhirPath + queryString`. If `localFhirStorePath` is set to an internal service URL and the caller supplies a crafted path, this becomes a full **SSRF proxy** to any path on the FHIR store host.

The `forwardToFacade` POST/PUT path uses `RequestDispatcher.forward()` to `/fhir/facade` + the extracted path — also without sanitization:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/fhir/controller/InternalFhirApi.java#L129-143
private void forwardToFacade(...) {
    String fhirPath = extractFhirPath(request);
    String targetUrl = buildQueryPath("/fhir/facade", fhirPath, request.getQueryString());
    RequestDispatcher dispatcher = request.getRequestDispatcher(targetUrl);
    dispatcher.forward(request, response);
}
```

---

## P4-C: HAPI Facade Servlet — No `IAuthorizationInterceptor`, No Auth at Servlet Level

```OpenELIS-Global-2/src/main/java/org/openelisglobal/fhir/servlets/FhirRestfulServer.java#L12-32
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

The HAPI FHIR `RestfulServer` is initialized with **zero interceptors registered**. HAPI provides a purpose-built `IAuthorizationInterceptor` (with `AuthorizationInterceptor` as the base) specifically for role-based resource-level access control. None is registered here. The servlet is mounted at `/fhir/facade/*` which is **not** in `SecurityConfig`'s Spring Security filter chain — it is a raw Java `Servlet`, registered directly via `AnnotationWebAppInitializer`:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/config/AnnotationWebAppInitializer.java#L35-40
ServletRegistration.Dynamic fhirServlet = servletContext.addServlet("FhirServlet",
        new FhirRestfulServer(rootContext));
fhirServlet.setLoadOnStartup(++startupOrder);
fhirServlet.addMapping("/fhir/facade/*");
```

Spring Security's filter chain **does not apply to servlets registered this way unless the `DelegatingFilterProxy` is mapped to that path**. Since the HAPI servlet bypasses Spring Security entirely, any authentication enforcement that Spring Security provides for `/rest/**` does not reach `/fhir/facade/*`. An unauthenticated caller who knows the path can directly call HAPI endpoints.

The only registered resource provider is `PractitionerProvider`, which handles `CREATE` and `UPDATE` — but because the HAPI server auto-discovers all `IResourceProvider` beans and the application currently has only one, the surface is currently limited. That said, there is **no enforcement mechanism** preventing future providers from being added and immediately being exposed without authorization.

---

## P4-D: Transformation and Export Triggers — No Auth, DoS / Data-Exfil Vector

### P4-D1 — `/OEToFhir` and `/PatientToFhir` expose full batch transforms to any user

```OpenELIS-Global-2/src/main/java/org/openelisglobal/fhir/transormation/controller/FhirTransformationController.java#L54-65
@GetMapping("/PatientToFhir")
public TransformationInfo transformPersistFhirPatients(
        @RequestParam(defaultValue = "false") Boolean checkAll,
        @RequestParam(defaultValue = "100") int batchSize,
        @RequestParam(defaultValue = "1") int threads,
        @RequestParam(defaultValue = "true") boolean waitForResults) {
    ...
    if (info.checkAll) {
        patients = sampleHumanService.getAllPatientsWithSampleEntered();
    } else {
        patients = sampleHumanService.getAllPatientsWithSampleEnteredMissingFhirUuid();
    }
    ...
    promises.add(fhirTransformService.transformPersistPatients(patientIds));
```

Any authenticated user can:
- Trigger a mass transformation of **all patients in the database** to FHIR format (`checkAll=true`)
- Push them all to the FHIR store in arbitrary batch sizes and thread counts
- Pass `waitForResults=false` to fire-and-forget hundreds of async threads simultaneously

This is a **DoS vector** (async thread exhaustion, FHIR store overload) and a **data exfil trigger** (forces patient PHI to sync to configured remote FHIR stores). The same applies to `/OEToFhir` which processes both Patients and Samples:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/fhir/transormation/controller/FhirTransformationController.java#L107-115
@GetMapping("/OEToFhir")
public TransformationInfo transformPersistMissingFhirObjects(
        @RequestParam(defaultValue = "false") Boolean checkAll, ...) {
    ...
    transformPersistFhirObjects(); // Processes ALL Patients + ALL Samples
```

### P4-D2 — `/OEToFhir/info` leaks internal processing state

```OpenELIS-Global-2/src/main/java/org/openelisglobal/fhir/transormation/controller/FhirTransformationController.java#L52-54
@GetMapping("/OEToFhir/info")
public TransformationInfo getTransformationInfo() {
    return info;
}
```

`TransformationInfo` exposes: `running`, `batches`, `batchFailure`, `objectType`, `phase`, `batchSize`, `threads`, `checkAll`, `waitForResults`. No auth check. An attacker can poll this to understand the database size (`batches * batchSize` ≈ total records), detect ongoing maintenance windows, and probe internal state.

### P4-D3 — `/dataexport/fhir` — Triggers all export tasks to remote FHIR servers

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/fhir/controller/FhirExportController.java#L14-24
@RestController
@RequestMapping("/dataexport/fhir")
public class FhirExportController {
    ...
    @PostMapping
    public void runAllDataExportTasks() throws ... {
        for (DataExportTask dataExportTask : dataExportTaskService.getDAO().findAll()) {
            dataExportService.exportNewDataFromLocalToRemote(dataExportTask);
        }
    }
}
```

Any authenticated user can trigger immediate export of all pending data to all configured remote FHIR servers. This is an **immediate PHI exfiltration trigger** with no rate-limit, no admin gate, and no audit log entry linking it to the requesting user.

---

## P4-E: `/fhir/optimizeStorage` — Admin FHIR Store Op, No Auth

```OpenELIS-Global-2/src/main/java/org/openelisglobal/fhir/actions/FhirActionController.java#L26-44
@PostMapping("/fhir/optimizeStorage")
public ResponseEntity<String> triggerOptimizeStorage() throws ... {
    HttpPost httpPost = new HttpPost(fhirConfig.getLocalFhirStorePath() + "/$reindex");
    String json = "{ \"resourceType\": \"Parameters\", \"parameter\": [{ \"name\": \"optimizeStorage\", \"valueString\": \"ALL_VERSIONS\" }] }";
    httpPost.setEntity(entity);
    ...
    try (CloseableHttpResponse res = httpClient.execute(httpPost)) {
        return ResponseEntity.status(res.getStatusLine().getStatusCode())
                .body(EntityUtils.toString(res.getEntity(), ...));
    }
}
```

**No role check whatsoever.** This endpoint:
1. Triggers a `$reindex` FHIR operation on the local store — a resource-intensive administrative operation
2. Is accessible to any authenticated user
3. Can be invoked repeatedly — a trivial **DoS** vector against the FHIR store (repeated full reindexing stalls query performance)

---

## P4-F: External Patient Search — TLS Trust-All + Credentials in URL Query String

```OpenELIS-Global-2/src/main/java/org/openelisglobal/common/externalLinks/ExternalPatientSearch.java#L185-192
// Ignore hostname mismatches and allow trust of self-signed certs
// TODO shouldn't let a self signed cert through
SSLSocketFactory sslsf = new SSLSocketFactory(new TrustSelfSignedStrategy(),
        SSLSocketFactory.ALLOW_ALL_HOSTNAME_VERIFIER);
Scheme https = new Scheme("https", 443, sslsf);
ClientConnectionManager ccm = httpclient.getConnectionManager();
ccm.getSchemeRegistry().register(https);
```

**`ALLOW_ALL_HOSTNAME_VERIFIER` is set explicitly** — the code even carries a `TODO` comment acknowledging this is wrong. This disables hostname verification entirely, meaning the TLS certificate presented by the remote patient search service is never matched against the expected hostname. This is a **man-in-the-middle** vulnerability — a network attacker can intercept the connection with any certificate.

Furthermore, credentials are passed as **URL query parameters**:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/common/externalLinks/ExternalPatientSearch.java#L299-310
private URI buildConnectionString(URI uriStart) {
    uriFinal = new URIBuilder(uriStart)
            .addParameter(GET_PARAM_FIRST, firstName)
            .addParameter(GET_PARAM_LAST, lastName)
            ...
            .addParameter(GET_PARAM_NAME, connectionName)     // username in URL
            .addParameter(GET_PARAM_PWD, connectionPassword)  // password in URL
            .build();
}
```

`GET_PARAM_NAME = "name"` and `GET_PARAM_PWD = "pwd"` — both placed in the query string. Query-string credentials appear in:
- Web server access logs on the remote server
- Browser history and referrer headers  
- Network intermediary logs (proxies, load balancers, WAFs)
- Error messages in stack traces if the request fails

---

## P4-G: FHIR Client Credentials — BasicAuth Over HTTP Fallback Risk

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/fhir/FhirUtil.java#L33-52
public IGenericClient getFhirClient(String fhirStorePath) {
    IGenericClient fhirClient = fhirContext.newRestfulGenericClient(fhirStorePath);
    if (!GenericValidator.isBlankOrNull(fhirConfig.getUsername())) {
        IClientInterceptor authInterceptor = new BasicAuthInterceptor(
                fhirConfig.getUsername(), fhirConfig.getPassword());
        fhirClient.registerInterceptor(authInterceptor);
    }
    return fhirClient;
}
```

`BasicAuthInterceptor` sends `Authorization: Basic <base64(user:pass)>` on every request. The FHIR store URL is configured via `org.openelisglobal.fhirstore.uri` — if this is ever set to an `http://` (not `https://`) URL in any environment (dev, staging, CI), credentials travel in cleartext. There is no enforcement in `FhirConfig` or `FhirUtil` that the store path must be HTTPS before attaching the `BasicAuthInterceptor`.

This same pattern is used in three call sites:
- `FhirUtil.getFhirClient(String)` — local store
- `FhirUtil.getLocalFhirClient()` — local store
- `FhirConfig.getRemoteStoreIdentifier()` — remote stores

---

## P4-H: `FhirConfig` — FHIR Store Credentials Exposed as Plain `@Value` Strings

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/fhir/FhirConfig.java#L43-56
@Getter
@Value("${org.openelisglobal.fhirstore.username:}")
private String username;

@Getter
@Value("${org.openelisglobal.fhirstore.password:}")
private String password;

@Getter
@Value("${org.openelisglobal.crserver.username:}")
private String clientRegistryUserName;

@Getter
@Value("${org.openelisglobal.crserver.password:}")
private String clientRegistryPassword;
```

All four credential fields carry `@Getter` (Lombok), making them **publicly accessible to any Spring bean** that gets a reference to `FhirConfig`. `FhirConfig` is a `@Configuration` bean injected broadly. If any logging framework or serialization path accidentally serializes `FhirConfig`, all four credentials appear in plaintext. The `clientRegistryPassword` is also passed directly into `getFhirClient(url, username, password)` calls, as seen in `PatientSearchRestController`.

---

## P4-I: `FhirRestfulServer` — Discovers Resource Providers at Runtime, No Registration Gate

```OpenELIS-Global-2/src/main/java/org/openelisglobal/fhir/servlets/FhirRestfulServer.java#L21-32
@Override
protected void initialize() throws ServletException {
    super.initialize();
    setFhirContext(FhirContext.forR4());

    Map<String, IResourceProvider> providerMap =
            applicationContext.getBeansOfType(IResourceProvider.class);
    List<IResourceProvider> providers = new ArrayList<>(providerMap.values());
    setResourceProviders(providers);
}
```

**All Spring beans implementing `IResourceProvider` are auto-registered** at startup. Any future developer who creates a new `IResourceProvider` `@Component` and forgets to add authorization logic will immediately expose a new FHIR endpoint with zero access control, with no build-time warning. The pattern requires individual providers to self-enforce authorization — a design that is easy to forget and impossible to audit centrally.

---

## P4-J: No FHIR Audit Trail for Data Access

Across all five FHIR surfaces, there is **no audit logging** when FHIR resources are read. The `AuditTrailReportRestController` records changes to OpenELIS entities via the `history` table, but:

- Reads via `GET /rest/fhir/{resourceType}/{resourceId}` are not logged
- Reads via `GET /fhir/**` passthrough are not logged  
- Bulk reads via `/OEToFhir` trigger are not logged as a user action
- `/dataexport/fhir` export triggers are not attributed to the requesting user

A data breach via the FHIR surface would leave no forensic trail.

---

## Risk Register — Phase 4

| ID | Surface | Finding | Severity | IHE/HIPAA Impact |
|---|---|---|---|---|
| **P4-A1** | `GET /rest/fhir/{resourceType}` | Arbitrary resource type + all params forwarded, no allowlist | 🔴 Critical | Any FHIR resource type readable by any user |
| **P4-A2** | `GET /rest/fhir/{resourceType}/{resourceId}` | Unguarded FHIR read by type+ID | 🔴 Critical | Full patient FHIR record traversal |
| **P4-A3** | `POST /rest/fhir/{resourceType}/_search` | Attacker-controlled body forwarded to FHIR store | 🔴 Critical | Injected search params, unlimited data harvest |
| **P4-A4** | `GET /rest/fhir/{resourceType}/_search` | Entire query string forwarded, no param filtering | 🔴 Critical | FHIR parameter injection |
| **P4-B** | `GET/POST /fhir/**` | Wildcard FHIR passthrough proxy, path traversal, SSRF | 🔴 Critical | Proxy to FHIR store's admin surface |
| **P4-C** | `/fhir/facade/*` | HAPI servlet bypasses Spring Security, zero `IAuthorizationInterceptor` | 🔴 Critical | Direct unauthenticated FHIR access |
| **P4-D1** | `GET /OEToFhir`, `/PatientToFhir` | Bulk PHI transform trigger, DoS, data exfil | 🔴 Critical | Mass PHI push to remote stores |
| **P4-D2** | `GET /OEToFhir/info` | Internal state leaks DB record counts | 🟡 Medium | Reconnaissance |
| **P4-D3** | `POST /dataexport/fhir` | Triggers all export tasks to remote FHIR servers | 🔴 Critical | Immediate PHI exfiltration |
| **P4-E** | `POST /fhir/optimizeStorage` | Triggers `$reindex` on FHIR store, no admin gate | 🟠 High | DoS via repeated reindex |
| **P4-F** | `ExternalPatientSearch` | `ALLOW_ALL_HOSTNAME_VERIFIER` + credentials in URL params | 🔴 Critical | MitM + credential exposure in logs |
| **P4-G** | `FhirUtil.getFhirClient` | BasicAuth over potentially HTTP connections | 🟠 High | Credential cleartext in transit |
| **P4-H** | `FhirConfig` | All FHIR store + client registry credentials as public `@Getter` Strings | 🟠 High | Credential exposure via serialization/logging |
| **P4-I** | `FhirRestfulServer` | Auto-discovers all `IResourceProvider` beans, no registration gate | 🟠 High | Future providers instantly exposed |
| **P4-J** | All FHIR surfaces | No FHIR access audit trail | 🟠 High | Breach undetectable |

---

## Concrete Remediation Patches

### Fix P4-A — Allowlist + Role-Gate the Query Proxy

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/fhir/controller/FhirQueryRestController.java#L59-65
// ADD at class level:
private static final Set<String> ALLOWED_RESOURCE_TYPES = Set.of(
    "Patient", "ServiceRequest", "DiagnosticReport", "Observation",
    "Practitioner", "Organization", "Specimen", "Task", "QuestionnaireResponse"
);

// ADD at method level on all four endpoints:
@PreAuthorize("hasAnyRole('ROLE_RESULTS','ROLE_VALIDATION','ROLE_GLOBAL_ADMIN')")
@GetMapping(value = "/{resourceType}", ...)
public ResponseEntity<?> queryFhirResources(@PathVariable String resourceType, ...) {
    if (!ALLOWED_RESOURCE_TYPES.contains(resourceType)) {
        return ResponseEntity.status(HttpStatus.FORBIDDEN)
                .body(Map.of("error", "Resource type not permitted"));
    }
    // Also: restrict forwarded query params to a known-safe set
    Set<String> ALLOWED_PARAMS = Set.of("_id","_lastUpdated","name","birthdate",
            "identifier","status","subject","_count","_sort","_include");
    ...
}
```

### Fix P4-B — Restrict InternalFhirApi to System-Only Calls

`InternalFhirApi` should not be publicly accessible at all — it is an internal routing component. Options:

1. **Remove the public routes entirely** and call FHIR store APIs only from server-side service code.
2. Or, restrict to localhost / internal network via a custom filter, and add `@PreAuthorize("hasRole('ROLE_GLOBAL_ADMIN')")` as a minimum.

```/dev/null/InternalFhirApi-fix.java#L1-8
// Option: Gate to admin only AND add path normalization
@PreAuthorize("hasRole('ROLE_GLOBAL_ADMIN')")
@GetMapping("/**")
public ResponseEntity<Object> recieveGetFhirRequests(HttpServletRequest request) {
    String fhirPath = sanitizeFhirPath(extractFhirPath(request)); // normalize, reject ..
    return forwardGetRequest(fhirPath, request.getQueryString());
}
```

### Fix P4-C — Register `IAuthorizationInterceptor` on the HAPI Servlet

```OpenELIS-Global-2/src/main/java/org/openelisglobal/fhir/servlets/FhirRestfulServer.java#L20-32
@Override
protected void initialize() throws ServletException {
    super.initialize();
    setFhirContext(FhirContext.forR4());

    // ADD: Register authorization interceptor BEFORE providers
    registerInterceptor(new OpenElisAuthorizationInterceptor());

    Map<String, IResourceProvider> providerMap =
            applicationContext.getBeansOfType(IResourceProvider.class);
    setResourceProviders(new ArrayList<>(providerMap.values()));
}
```

```/dev/null/OpenElisAuthorizationInterceptor.java#L1-25
public class OpenElisAuthorizationInterceptor extends AuthorizationInterceptor {
    @Override
    public List<IAuthRule> buildRuleList(RequestDetails theRequestDetails) {
        // Reject unauthenticated requests at the HAPI layer
        HttpServletRequest httpReq = (HttpServletRequest) theRequestDetails.getServletRequest();
        HttpSession session = httpReq.getSession(false);
        if (session == null || session.getAttribute(IActionConstants.USER_SESSION_DATA) == null) {
            return new RuleBuilder().denyAll("No active session").build();
        }
        // Role-based rules:
        return new RuleBuilder()
            .allow().read().resourcesOfType(Practitioner.class).withAnyId().andThen()
            .allow().write().resourcesOfType(Practitioner.class).withAnyId().andThen()
            .denyAll("Default deny")
            .build();
    }
}
```

### Fix P4-D — Gate Transformation and Export Endpoints to Admin

```OpenELIS-Global-2/src/main/java/org/openelisglobal/fhir/transormation/controller/FhirTransformationController.java#L27-65
// ADD @PreAuthorize at class level — all three endpoints gated in one declaration:
@RestController
@PreAuthorize("hasRole('ROLE_GLOBAL_ADMIN')")
public class FhirTransformationController extends BaseController {
    ...
    // Also add a max cap on batchSize and threads to prevent thread-bomb:
    @GetMapping("/PatientToFhir")
    public TransformationInfo transformPersistFhirPatients(
            @RequestParam(defaultValue = "false") Boolean checkAll,
            @RequestParam(defaultValue = "100") int batchSize,   // cap at 500
            @RequestParam(defaultValue = "1")   int threads,     // cap at 4
            @RequestParam(defaultValue = "true") boolean waitForResults) {
        batchSize = Math.min(batchSize, 500);
        threads   = Math.min(threads, 4);
        ...
    }
}
```

Apply the same `@PreAuthorize("hasRole('ROLE_GLOBAL_ADMIN')")` to:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/fhir/controller/FhirExportController.java#L20-24
@RestController
@RequestMapping("/dataexport/fhir")
@PreAuthorize("hasRole('ROLE_GLOBAL_ADMIN')")   // ADD
public class FhirExportController {
```

### Fix P4-E — Gate `/fhir/optimizeStorage` to Admin

```OpenELIS-Global-2/src/main/java/org/openelisglobal/fhir/actions/FhirActionController.java#L26-29
@PreAuthorize("hasRole('ROLE_GLOBAL_ADMIN')")   // ADD
@PostMapping("/fhir/optimizeStorage")
public ResponseEntity<String> triggerOptimizeStorage() throws ... {
```

Additionally, implement a cooldown guard so this can't be invoked more than once per configurable interval, preventing repeated `$reindex` DoS:

```/dev/null/FhirActionController-fix.java#L1-12
private static volatile Instant lastReindexTime = Instant.EPOCH;
private static final Duration REINDEX_COOLDOWN = Duration.ofMinutes(30);

@PreAuthorize("hasRole('ROLE_GLOBAL_ADMIN')")
@PostMapping("/fhir/optimizeStorage")
public ResponseEntity<String> triggerOptimizeStorage() throws ... {
    if (Duration.between(lastReindexTime, Instant.now()).compareTo(REINDEX_COOLDOWN) < 0) {
        return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
                .body("Reindex cooldown in effect. Try again later.");
    }
    lastReindexTime = Instant.now();
    ...
}
```

### Fix P4-F — Fix TLS Trust-All and Remove Credentials from URL

Replace the deprecated trust-all pattern in `ExternalPatientSearch`:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/common/externalLinks/ExternalPatientSearch.java#L185-196
// REMOVE THIS ENTIRE BLOCK:
SSLSocketFactory sslsf = new SSLSocketFactory(new TrustSelfSignedStrategy(),
        SSLSocketFactory.ALLOW_ALL_HOSTNAME_VERIFIER);
Scheme https = new Scheme("https", 443, sslsf);
ClientConnectionManager ccm = httpclient.getConnectionManager();
ccm.getSchemeRegistry().register(https);

// REPLACE WITH: inject the shared CloseableHttpClient from HttpClientConfig
// (it already uses a proper truststore — see HttpClientConfig.httpClient())
// @Autowired CloseableHttpClient httpClient;
// ... use httpClient directly instead of HttpClientBuilder.create().build()
```

Move credentials from URL query string to `Authorization` header:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/common/externalLinks/ExternalPatientSearch.java#L299-312
// REMOVE credential params from URIBuilder:
uriFinal = new URIBuilder(uriStart)
    .addParameter(GET_PARAM_FIRST, firstName)
    .addParameter(GET_PARAM_LAST, lastName)
    .addParameter(GET_PARAM_ST, STNumber)
    .addParameter(GET_PARAM_SUBJECT, subjectNumber)
    .addParameter(GET_PARAM_NATIONAL_ID, nationalId)
    .addParameter(GET_PARAM_GUID, guid)
    // REMOVE: .addParameter(GET_PARAM_NAME, connectionName)
    // REMOVE: .addParameter(GET_PARAM_PWD, connectionPassword)
    .build();

// ADD credentials as Authorization header instead:
String encoding = Base64.getEncoder().encodeToString(
        (connectionName + ":" + connectionPassword).getBytes(StandardCharsets.UTF_8));
httpget.setHeader(HttpHeaders.AUTHORIZATION, "Basic " + encoding);
```

### Fix P4-G — Enforce HTTPS Before Attaching BasicAuth

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/fhir/FhirUtil.java#L33-52
public IGenericClient getFhirClient(String fhirStorePath) {
    // ADD: guard against accidental HTTP usage with credentials
    if (!GenericValidator.isBlankOrNull(fhirConfig.getUsername())) {
        if (!fhirStorePath.startsWith("https://")) {
            LogEvent.logWarn(this.getClass().getSimpleName(), "getFhirClient",
                    "SECURITY WARNING: BasicAuth credentials will NOT be attached to non-HTTPS FHIR path: "
                    + fhirStorePath);
            // In production, throw instead of silently degrading:
            // throw new IllegalStateException("FHIR store path must use HTTPS when credentials are configured");
        } else {
            IClientInterceptor authInterceptor = new BasicAuthInterceptor(
                    fhirConfig.getUsername(), fhirConfig.getPassword());
            fhirClient.registerInterceptor(authInterceptor);
        }
    }
    return fhirClient;
}
```

Apply the same guard to `getLocalFhirClient()` and `FhirConfig.getRemoteStoreIdentifier()`.

### Fix P4-H — Remove `@Getter` from Credential Fields

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/fhir/FhirConfig.java#L40-56
// BEFORE — Lombok @Getter on every field including credentials:
@Getter
@Value("${org.openelisglobal.fhirstore.password:}")
private String password;

// AFTER — No @Getter on credential fields; provide package-scoped accessor only:
@Value("${org.openelisglobal.fhirstore.password:}")
private String password;

// Provide a method only within the fhir package, NOT public:
// (or use Spring's @ConfigurationPropertiesBinding with a dedicated CredentialHolder)
BasicAuthInterceptor newLocalStoreAuthInterceptor() {
    return new BasicAuthInterceptor(username, password);
}
```

This prevents `fhirConfig.getPassword()` calls from anywhere in the codebase, centralizing credential usage in `FhirConfig` itself.

### Fix P4-I — Require Explicit Provider Registration

Replace auto-discovery with an explicit registration list to prevent accidental exposure of new providers:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/fhir/servlets/FhirRestfulServer.java#L20-32
@Override
protected void initialize() throws ServletException {
    super.initialize();
    setFhirContext(FhirContext.forR4());

    // Register authorization interceptor FIRST
    registerInterceptor(applicationContext.getBean(OpenElisAuthorizationInterceptor.class));

    // EXPLICIT registration instead of auto-discovery:
    // Each provider must be deliberately added here to be exposed.
    List<IResourceProvider> providers = List.of(
        applicationContext.getBean(PractitionerProvider.class)
        // Future providers added here intentionally, after security review
    );
    setResourceProviders(providers);
}
```

### Fix P4-J — Add FHIR Access Audit Logging

Add a HAPI server interceptor that records all FHIR reads to the existing `history` audit table:

```/dev/null/FhirAccessAuditInterceptor.java#L1-22
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
                "FHIR " + requestDetails.getRequestType() + " " + resourceType
                + "/" + resourceId + " by user=" + userId);
        // Persist to history table for ISO 15189 non-repudiation
        historyService.recordFhirAccess(userId, resourceType, resourceId,
                requestDetails.getRequestType().name());
    }
}
```

Register this interceptor in `FhirRestfulServer.initialize()` alongside `OpenElisAuthorizationInterceptor`.

---

## Phase 4 Conclusion

The FHIR security posture has **five simultaneously exposed attack surfaces**, none of which carry role-based access control. The most critical findings in priority order are:

1. **P4-C** — The HAPI servlet at `/fhir/facade/*` bypasses Spring Security entirely and has no `IAuthorizationInterceptor`. This is the deepest unguarded entry point into the FHIR store.

2. **P4-A1–A4** — The `FhirQueryRestController` is a fully open FHIR search proxy. The combination of arbitrary `{resourceType}`, unfiltered query parameter forwarding, and a POST body pass-through is equivalent to granting any authenticated user a direct FHIR API key to the local store.

3. **P4-D1+D3** — `/PatientToFhir`, `/OEToFhir`, and `/dataexport/fhir` are on-demand data exfiltration and DoS triggers. Any authenticated user can force all patient records to sync to remote FHIR servers.

4. **P4-F** — The external patient search TLS trust-all + credentials-in-URL is the most immediately exploitable finding if a network-level attacker is present, as it enables both credential theft and MitM interception of patient demographic data.

5. **P4-B** — The `InternalFhirApi` wildcard proxy introduces SSRF risk and zero-sanitization path forwarding, compounding the blast radius of everything above.

The architectural fix sequence should be: **enable `@EnableMethodSecurity`** (from P3-I, prerequisite) → **register `IAuthorizationInterceptor` on HAPI servlet** → **add resource type allowlist to `FhirQueryRestController`** → **gate all admin FHIR endpoints to `ROLE_GLOBAL_ADMIN`** → **fix ExternalPatientSearch TLS and credential placement** → **add FHIR audit logging**.

---

Ready to move to **Phase 5: Infrastructure Hardening** — the final stage, covering Docker/deployment configuration, secrets management, nginx proxy headers, Tomcat hardening, and environment-level security controls.
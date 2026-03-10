OpenELIS Security Audit — Phase 2 Detailed Report

This phase dives deep into **input validation & injection risks**, **file upload attack surfaces**, **broken access control patterns across controllers**, **FHIR endpoint exposure**, **audit trail integrity**, **system administration weaknesses**, **hard-coded system user IDs**, **analyzer TCP SSRF**, **logging controller exposure**, and **report generation security**. Each finding is tied directly to code evidence.

---

## P2-A: Broken Object-Level Authorization (BOLA) — Patient & PHI Endpoints

### P2-A1 — `PatientSearchRestController`: Unauthenticated patient data enumeration

**File:** `src/main/java/org/openelisglobal/common/rest/provider/PatientSearchRestController.java` (L80–169)

**Vulnerability:** The `/rest/patient-search-results` and `/rest/patient-search` GET endpoints return full PHI (first name, last name, DOB, gender, national ID, subject number, GUID, lab numbers). While Spring Security requires authentication for `/rest/**`, the `ModuleAuthenticationInterceptor` explicitly returns `true` for all REST paths when no module is assigned to the URL:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/interceptor/ModuleAuthenticationInterceptor.java#L98-105
if (sysModsByUrl.isEmpty() && REQUIRE_MODULE) {
    if (isRestFullPath()) {
        return true;  // <-- PASSES without role check!
    }
    LogEvent.logWarn("ModuleAuthenticationInterceptor", "hasPermissionForUrl()",
            "This page has no modules assigned to it");
    return false;
}
```

Any authenticated session — regardless of role — can call `/rest/patient-search?lastName=Smith` and get back a full list of matching patients. There is **no role check** at the endpoint level or in the interceptor for REST paths. This is especially dangerous because `/rest/patient-search` (L166–169) directly delegates to `SearchResultsService` with no filtering of what data can be returned based on the requester's role.

**Impact:** Any logged-in user (even one with only the "Reception" role or a freshly auto-provisioned SAML account) can enumerate all patients by name, DOB, or national ID — constituting a HIPAA/PHI data breach vector.

---

### P2-A2 — `AuditTrailReportRestController`: No authorization check on audit trail endpoint

**File:** `src/main/java/org/openelisglobal/audittrail/controller/rest/AuditTrailReportRestController.java` (L15–33)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/audittrail/controller/rest/AuditTrailReportRestController.java#L14-33
@RestController
public class AuditTrailReportRestController {

    @GetMapping("/rest/AuditTrailReport")
    public ResponseEntity<AuditTrailViewForm> getAuditTrailReport(@RequestParam String accessionNumber) {
        ...
        AuditTrailViewWorker worker = SpringContext.getBean(AuditTrailViewWorker.class);
        worker.setAccessionNumber(accessionNumber);
        List<AuditTrailItem> items = worker.getAuditTrail();
        ...
        response.setPatientProperties(worker.getPatientSnapshot());
        return ResponseEntity.ok(response);
    }
}
```

The audit trail endpoint returns **patient snapshots and full audit change history** for any accession number passed as a query parameter. There is **no role check** (`@PreAuthorize`, `hasRole`, interceptor module check, or manual `isUserAdmin` call). The audit trail is intended to be a privileged, compliance-sensitive operation (ISO 15189 / SLIPTA), but any authenticated user can read the full history of any sample and see the associated patient data. The `ROLE_AUDIT_TRAIL` role constant defined in `Constants.java` is never enforced here.

**Impact:** Circumvents the `ROLE_AUDIT_TRAIL` role entirely; any user can read the PHI-containing audit trail for any sample accession number.

---

### P2-A3 — `UnifiedSystemUserRestController`: Users endpoint exposes all usernames without role check

**File:** `src/main/java/org/openelisglobal/systemuser/controller/rest/UnifiedSystemUserRestController.java` (L142–147)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/systemuser/controller/rest/UnifiedSystemUserRestController.java#L142-147
@GetMapping(value = "/users")
@ResponseBody
public List<IdValuePair> getUsersWithRole() {
    List<SystemUser> users = systemUserService.getAll();
    List<IdValuePair> idValues = users.stream()
        .map(e -> new IdValuePair(e.getId(), e.getDisplayName()))
        .collect(Collectors.toList());
    return idValues;
}
```

This `GET /rest/users` endpoint returns the **full list of system users** (IDs + display names) with **no role restriction**. Combined with the `GET /rest/users/{roleName}` endpoint, an attacker can enumerate all usernames in the system to assist in targeted credential attacks or social engineering.

---

## P2-B: Admin Data Deletion with Weak Guard

### P2-B1 — `DeletePatientTestDataController`: Mass-deletion gated only on a configuration property

**File:** `src/main/java/org/openelisglobal/common/controller/DeletePatientTestDataController.java` (L30–56)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/common/controller/DeletePatientTestDataController.java#L31-36
@PostMapping(value = "/DatabaseCleaningRequest")
public String cleanSamplePatientDatabaseEntries(HttpServletRequest request) {
    if (!"true".equals(ConfigurationProperties.getInstance()
            .getPropertyValueLowerCase(ConfigurationProperties.Property.TrainingInstallation))) {
        return findForward(FWD_FAIL_DELETE);
    }
    databaseCleanService.cleanDatabase();
```

The entire safeguard against wiping the patient database is a single configuration key `TrainingInstallation`. There is:
- **No `isUserAdmin` check.**
- **No ROLE_GLOBAL_ADMIN enforcement.**
- **No CSRF token** (all `/rest/**` paths skip CSRF; this is a form POST at `/DatabaseCleaningRequest`).

If `TrainingInstallation=true` is accidentally set on a production system (or if the config is manipulated via the DB), any authenticated user can submit a POST to `/DatabaseCleaningRequest` and destroy all patient and sample data. There is no confirmation token, no secondary authorization step, and no warning.

**Impact:** Complete, irreversible destruction of all patient test data by any authenticated user on misconfigured systems.

---

## P2-C: Unauthenticated/Unguarded Administrative Endpoints

### P2-C1 — `ImportController`: No authentication, no role check

**File:** `src/main/java/org/openelisglobal/admin/controller/ImportController.java`

```OpenELIS-Global-2/src/main/java/org/openelisglobal/admin/controller/ImportController.java#L13-50
@RestController
@RequestMapping("/import")
public class ImportController {
    ...
    @GetMapping(value = "/all")
    public void importAll() throws ... {
        importDataFromFhir(ResourceType.ORGANIZATION);
        importDataFromFhir(ResourceType.PROVIDER);
    }
```

The `/import/all`, `/import/organization`, and `/import/provider` GET endpoints trigger **data import from the external FHIR server** — pulling and persisting organizations and providers into the database. These endpoints:
1. Have **no `@PreAuthorize` or role check**.
2. Are under `/import/**`, which is **not in `SecurityConfig.OPEN_PAGES`**, but also not in `REST_CONTROLLERS = {"/rest/**"}`. Their placement under Spring Security depends on the catch-all `anyRequest().authenticated()` rule, but the `ModuleAuthenticationInterceptor` would apply and return `true` for them since they have no module assignment.
3. Any authenticated user can invoke these, triggering FHIR pulls that could flood the database, create duplicate records, or overwrite valid data.

**Impact:** Unauthorized mass import of organization/provider data; potential data integrity corruption.

---

### P2-C2 — `MassIndexerRestController`: Reindex endpoint unguarded

**File:** `src/main/java/org/openelisglobal/hibernate/search/massindexer/MassIndexerRestController.java`

```OpenELIS-Global-2/src/main/java/org/openelisglobal/hibernate/search/massindexer/MassIndexerRestController.java#L11-23
@RestController
@RequestMapping("/rest")
public class MassIndexerRestController {
    @GetMapping("/reindex")
    public ResponseEntity<Boolean> reindex() {
        try {
            massIndexerService.reindex();
            return ResponseEntity.ok(true);
        } catch (Exception e) {
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(false);
        }
    }
}
```

The `/rest/reindex` endpoint triggers a **full Hibernate Search mass-reindex** operation, which can consume significant CPU and memory for extended periods, causing a **Denial-of-Service (DoS)** on the database and application. There is no authentication check beyond basic session existence, no rate limiting, and no admin role guard.

**Impact:** Any authenticated user can trigger repeated reindexes, causing application unavailability — effectively a DoS attack on a healthcare system.

---

### P2-C3 — `LoggingController`: Log level manipulation without authentication

**File:** `src/main/java/org/openelisglobal/logging/controller/LoggingController.java`

```OpenELIS-Global-2/src/main/java/org/openelisglobal/logging/controller/LoggingController.java#L11-52
@RestController
public class LoggingController {
    @GetMapping(path = "/logging")
    public void changeLoggingLevel(
        @RequestParam(name = "logLevel", defaultValue = "I") String logLevel,
        @RequestParam(name = "logger", defaultValue = "org.openelisglobal") String logger,
        @RequestParam(name = "rootLogLevel", defaultValue = "I") String rootLogLevel) {
        ...
        Configurator.setLevel(logger, log4jLogLevel);
```

The `/logging` endpoint can be called by **any authenticated user** with no admin role check. An attacker can:
1. Set `rootLogLevel=A` (ALL) to enable TRACE-level Hibernate SQL logging globally, causing PHI to flood into logs (which Phase 1 flagged at C-1).
2. Set `rootLogLevel=O` (OFF) to blind the logging system, hiding their own attack activities.
3. Pass an arbitrary `logger` package name, affecting third-party library log levels.
4. Call `/logging/test` to confirm what's written to the log file and validate their blind attack on the logging infrastructure.

**Impact:** Attackers can selectively enable PHI logging to fill log files (disk DoS) or silence all logging to evade detection — critical in a healthcare audit trail context.

---

## P2-D: FHIR Endpoint — Unrestricted Resource Type Access

### P2-D1 — `FhirQueryRestController`: Arbitrary FHIR resource type traversal

**File:** `src/main/java/org/openelisglobal/dataexchange/fhir/controller/FhirQueryRestController.java` (L62–128)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/fhir/controller/FhirQueryRestController.java#L62-110
@GetMapping(value = "/{resourceType}", produces = MediaType.APPLICATION_JSON_VALUE)
public ResponseEntity<?> queryFhirResources(@PathVariable("resourceType") String resourceType, ...) {
    ...
    StringBuilder searchUrl = new StringBuilder();
    searchUrl.append(fhirConfig.getLocalFhirStorePath())
             .append("/").append(resourceType).append("?");
    // All query parameters passed through verbatim
    Map<String, String[]> parameterMap = request.getParameterMap();
    for (Map.Entry<String, String[]> entry : parameterMap.entrySet()) {
        ...
        searchUrl.append(URLEncoder.encode(paramName, StandardCharsets.UTF_8))
                 .append("=")
                 .append(URLEncoder.encode(value, StandardCharsets.UTF_8));
    }
    Bundle bundle = (Bundle) fhirClient.fetchResourceFromUrl(Bundle.class, searchUrl.toString());
```

The `{resourceType}` path variable is **never validated** against an allowlist of known FHIR resource types. This means:
1. Any authenticated user can request `/rest/fhir/Patient?identifier=12345` and retrieve all FHIR patient resources.
2. They can request `/rest/fhir/DiagnosticReport`, `/rest/fhir/Observation`, etc., retrieving all lab results.
3. All HTTP request parameters are passed **verbatim** (URL-encoded) into the FHIR server URL, enabling FHIR-level parameter injection (e.g., `_include`, `_revinclude`, `_has` to traverse relationships, or `_security` to bypass filters).
4. The `GET /{resourceType}/_search` endpoint does the same with a raw `queryString` param passed directly.

There is **no FHIR authorization interceptor**, no resource-type allowlist, and no user-role-to-FHIR-resource mapping.

**Impact:** Full read access to all FHIR-stored PHI (Patients, Observations, DiagnosticReports, ServiceRequests) for any authenticated user, circumventing the LIMS role model entirely.

---

### P2-D2 — FHIR `/{resourceType}/{resourceId}` — Resource ID injection

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/fhir/controller/FhirQueryRestController.java#L139-158
@GetMapping(value = "/{resourceType}/{resourceId}", produces = MediaType.APPLICATION_JSON_VALUE)
public ResponseEntity<?> getFhirResource(@PathVariable("resourceType") String resourceType,
        @PathVariable("resourceId") String resourceId) {
    ...
    IBaseResource resource = fhirClient.read()
            .resource(resourceType)
            .withId(resourceId)
            .execute();
```

Both `resourceType` and `resourceId` are passed **directly to the HAPI FHIR client with no validation**. The `resourceId` is not validated to be a valid UUID or numeric ID format, and `resourceType` is not checked against the FHIR R4 resource type enum. This allows:
- Reading `Patient/../../administration` style path traversal attempts (HAPI client may sanitize, but this hasn't been verified).
- Reading arbitrary resource IDs across all patients if the FHIR server doesn't enforce compartment-based access control.

---

## P2-E: File Upload Vulnerabilities

### P2-E1 — `LogoUploadRestController`: Extension-only validation, no MIME-type check

**File:** `src/main/java/org/openelisglobal/logo/controller/rest/LogoUploadRestController.java` (L177–182)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/logo/controller/rest/LogoUploadRestController.java#L177-185
private boolean validToWrite(MultipartFile logoFile) {
    boolean valid = logoFile.getSize() > 0
        && !GenericValidator.isBlankOrNull(logoFile.getOriginalFilename())
        && (logoFile.getOriginalFilename().contains("jpg")
            || logoFile.getOriginalFilename().contains("png")
            || logoFile.getOriginalFilename().contains("gif"));
    try (InputStream input = logoFile.getInputStream()) {
        ImageIO.read(input);
    } catch (IOException e) {
        valid = false;
    }
    return valid;
}
```

The filename check uses **`.contains()` not `.endsWith()`**, meaning a filename like `malicious.jpg.jsp` or `evil.png.sh` would pass the check. While `ImageIO.read()` does provide some protection by verifying the content is a valid image, the file is written to disk using `logoFile.transferTo(previewFile)` **before** the extension check happens. If `transferTo` succeeds and later processing fails, the file remains on disk. Additionally, the preview path concatenation:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/logo/controller/rest/LogoUploadRestController.java#L109-112
File previewFile = new File(
    imageService.getFullPreviewPath() + imageService.getImageNameFilePath(whichLogo));
logoFile.transferTo(previewFile);
```

The `whichLogo` value comes from the form's `logoName` field. If `getImageNameFilePath(whichLogo)` does not sanitize the logo name, path traversal is possible (e.g., `logoName=../../webroot/malicious.jsp`).

---

### P2-E2 — `AnalyzerImportController`: Filename-based reader selection without content validation

**File:** `src/main/java/org/openelisglobal/analyzerimport/action/AnalyzerImportController.java` (L52–80)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/analyzerimport/action/AnalyzerImportController.java#L52-80
@PostMapping("/importAnalyzer")
protected void doPost(@RequestParam("file") MultipartFile file, ...) {
    ...
    reader = AnalyzerReaderFactory.getReaderFor(file.getOriginalFilename());
    if (reader != null) {
        fileRead = reader.readStream(stream);
    }
```

The `AnalyzerReaderFactory.getReaderFor()` receives the **raw `getOriginalFilename()`** from the client. The client controls this filename entirely. There is:
1. **No content-type validation** of the uploaded file.
2. **No size limit** at the application layer (only a servlet-level 10MB/20MB cap in `AnnotationWebAppInitializer`).
3. The file is streamed **directly into the analyzer reader** without sanitization, meaning a malicious file crafted to exploit parser vulnerabilities in the HL7/ASTM readers could be uploaded.
4. The HL7 endpoint `/analyzer/hl7` (L130–170) reads **raw bytes from `request.getInputStream()`** with no size cap enforced at the application layer.

The HL7 fallback user ID:
```OpenELIS-Global-2/src/main/java/org/openelisglobal/analyzerimport/action/AnalyzerImportController.java#L146-148
if (userId == null) {
    userId = "1";  // Falls back to system user ID 1 (admin)
}
```

If no session exists, all HL7-imported data is credited to **user ID 1** (the admin system user), completely hiding the true source of potentially malicious analyzer data.

---

### P2-E3 — `GenericSampleOrderRestController`: File import with MIME type but no allowlist validation

```OpenELIS-Global-2/src/main/java/org/openelisglobal/genericsample/controller/rest/GenericSampleOrderRestController.java#L101-114
@PostMapping(value = "/GenericSampleOrder/validate", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
public ResponseEntity<?> validateImportFile(@RequestParam("file") MultipartFile file) {
    ...
    GenericSampleImportResult result = genericSampleOrderService.validateImportFile(
        inputStream, file.getOriginalFilename(), file.getContentType());
```

The `contentType` is passed directly from the client's `Content-Type` header, which the client controls entirely. The service then uses this client-supplied MIME type to determine how to parse the file. An attacker can send `Content-Type: text/csv` with a malicious payload designed to exploit CSV injection or parser flaws.

---

## P2-F: Hard-Coded System User ID "1" — Audit Trail Poisoning

**Files (multiple):**

**Finding:** Throughout the codebase, the string `"1"` is used as a fallback/default `sysUserId` in multiple places:

1. **`AnalyzerImportController`** (L146–148): HL7 imports with no session fall back to `userId = "1"`.
2. **`FileImportWatchService`** (L144–148): File-based analyzer imports default to `systemUserId = "1"`.
3. **`StorageLocationRestController`** (L365–367): Device creation falls back to `sysUserId = "1"`.
4. **`ResultReportingTransfer`** (L131, L178): `ReportExternalExport` and `DocumentTrack` records are saved with `setSysUserId("1")` — hardcoded, not from the actual user.
5. **`OclToOpenElisMapper`** (L52): The OCL concept mapper uses `systemUserId = "1"` for all created records.

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/resultreporting/ResultReportingTransfer.java#L131-135
report.setSysUserId("1");
```

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/resultreporting/ResultReportingTransfer.java#L178-179
document.setSysUserId("1");
```

**Impact:** The audit trail (`history` table) records attributed to user ID 1 are indistinguishable from legitimate admin actions. An attacker who triggers actions through unauthenticated endpoints or through analyzer import paths will have their activities hidden under the admin account. This directly violates **ISO 15189 audit trail requirements** (all changes must be attributed to the actual human actor).

---

## P2-G: Password Policy Inconsistency and Country-Specific Branching

### P2-G1 — `PasswordValidationFactory`: Country-name-based password policy (Constitution violation)

**File:** `src/main/java/org/openelisglobal/common/provider/validation/PasswordValidationFactory.java`

```OpenELIS-Global-2/src/main/java/org/openelisglobal/common/provider/validation/PasswordValidationFactory.java#L22-37
if (MINN_SITE.equals(requirementSite)) {
    // no-op Minnesota is the default
} else if (HAITI_SITE.equals(requirementSite)) {
    validator = new HaitiPasswordValidation();
} else if (CDI_SITE.equals(requirementSite)) {
    validator = new CDIPasswordValidation();
}
```

This is a **Constitution Principle I violation**: country-specific branching in production code (MINN, HAITI, CDI). The `HaitiPasswordValidation` enforces only a 7-character minimum with one special character, while `MinnPasswordValidation` requires 8 characters and complexity from 3 of 4 classes. The weakest policy (`HaitiPasswordValidation`, 7 chars + 1 special) could be trivially satisfied with passwords like `aaaaaa!` — far below modern standards.

**Impact:** Healthcare sites configured with `HAITI` or `CDI` password requirements are exposed to credential brute-force attacks due to weaker minimum password strength.

---

### P2-G2 — `PasswordUtil.generatePassword()`: String concatenation in loop

**File:** `src/main/java/org/openelisglobal/security/PasswordUtil.java` (L34–40)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/PasswordUtil.java#L34-40
public static String generatePassword() {
    String result = "";
    for (int i = 0; i < PASSWORD_LENGTH; i++) {
        int index = RANDOM.nextInt(CHARSET.length());
        result += CHARSET.charAt(index);  // String concat in loop -- character leaked in memory
    }
    return result;
}
```

Beyond the minor performance issue (String concatenation in a loop), this leaves intermediate password characters in JVM string intern pools. A more critical issue: the generated password is **returned as a `String`**, not a `char[]`. In Java, `String` objects cannot be zeroed from memory after use, meaning generated passwords persist in the heap until GC, potentially exploitable via heap dump analysis. This is a best-practice violation for password handling.

---

## P2-H: External Connection Credentials — Plaintext Transmission Risk

### P2-H1 — `BasicAuthenticationData.getAuthenticationString()` — Credentials in memory as String

**File:** `src/main/java/org/openelisglobal/externalconnections/valueholder/BasicAuthenticationData.java`

```OpenELIS-Global-2/src/main/java/org/openelisglobal/externalconnections/valueholder/BasicAuthenticationData.java#L36-39
@Override
public String getAuthenticationString() {
    return "Basic " + Base64.getEncoder()
        .encodeToString((username + ":" + password).getBytes());
}
```

The `password` field is stored encrypted in the DB via `EncryptionConverter` (AES-256, via Jasypt). However:
1. When `getAuthenticationString()` is called, the **decrypted password is concatenated into a `String`** and returned — this intermediate String and the Base64 header live in the JVM heap with no way to erase them.
2. The Base64-encoded Basic Auth header is the **actual cleartext credential** — if logged anywhere (e.g., with TRACE Hibernate logging enabled via the `LoggingController`), it would expose credentials.
3. The `ExternalConnectionController` form handler (`fillForm`) loads and populates `basicAuthenticationData.password` into the form object returned to the template — this means the decrypted password is temporarily in the HTTP response pipeline.

---

## P2-I: Report Generation — Unvalidated Report Name (Report Injection)

### P2-I1 — `ReportRestController`: `form.getReport()` passed to factory without allowlist

**File:** `src/main/java/org/openelisglobal/reports/controller/rest/ReportRestController.java` (L45–60)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/reports/controller/rest/ReportRestController.java#L45-60
IReportCreator reportCreator = ReportImplementationFactory.getReportCreator(form.getReport());
if (reportCreator != null) {
    reportCreator.setSystemUserId(getSysUserId(request));
    reportCreator.setRequestedReport(form.getReport());
    reportCreator.initializeReport(form);
    reportCreator.setReportPath(getReportPath());
    ...
    byte[] bytes = reportCreator.runReport();
```

The `form.getReport()` string (attacker-controlled from the POST body) is passed to `ReportImplementationFactory.getReportCreator()`. The factory uses a long chain of `if/else if` comparisons. If a match is found, a report implementation is instantiated. If no match is found, `reportCreator` is `null` and nothing happens. **However:**

1. The `getReportPath()` eventually resolves to a classpath resource. If an attacker discovers internal report names not normally exposed in the UI, they can invoke them arbitrarily.
2. More critically, `reportCreator.setRequestedReport(form.getReport())` stores the **raw attacker-supplied string** in the report object. If any report implementation uses `requestedReport` to construct file paths or SQL queries (this would need individual audit of each implementation), injection could occur.
3. There is **no role-to-report mapping** enforcement at the REST endpoint level. A "Reception" role user could POST and generate a "patientCILNSP" clinical report for all patients if they know the report name string.

---

## P2-J: Analyzer TCP Connection — SSRF Risk Despite NetworkValidationUtil

### P2-J1 — `NetworkValidationUtil` allows all private ranges — SSRF to internal services

**File:** `src/main/java/org/openelisglobal/analyzer/util/NetworkValidationUtil.java`

```OpenELIS-Global-2/src/main/java/org/openelisglobal/analyzer/util/NetworkValidationUtil.java#L36-60
public static boolean isBlockedAddress(String ipAddress) {
    ...
    InetAddress addr = InetAddress.getByName(ipAddress);
    return isBlockedAddress(addr);
}

private static boolean isBlockedAddress(InetAddress addr) {
    if (addr.isLoopbackAddress()) { return true; }
    if (addr.isLinkLocalAddress()) { return true; }
    if (addr.isMulticastAddress()) { return true; }
    if (addr.isAnyLocalAddress()) { return true; }
    // Private ranges (10.x, 172.16.x, 192.168.x) are intentionally allowed
    return false;
}
```

The comment explicitly states private ranges are **intentionally allowed**. However, in a Docker/Kubernetes environment, this means an authenticated admin can configure an analyzer to point to:
- `10.x.x.x` — internal Docker network services (database at `10.0.0.2:5432`, other microservices)
- `172.16.x.x` — internal bridge network addresses
- `192.168.x.x` — host-internal services

The `testTcpConnection()` and `testHl7Connection()` methods then open a **real TCP socket** to the configured address, sending ENQ/ACK or HL7 data. While this is admittedly a secondary risk (requires "Analyzer admin" privileges), it enables **SSRF from the application tier to internal backend services** (PostgreSQL, HAPI FHIR server, Redis, etc.).

**Impact:** A privileged attacker can probe internal network topology, fingerprint internal services, and potentially exploit services that trust connections from localhost/internal ranges.

---

## P2-K: Missing Rate Limiting on Authentication Endpoints

**Finding:** The entire Spring Security configuration contains **no rate limiting** on:
- `/ValidateLogin` (form login endpoint)
- `/rest/**` (Basic Auth endpoints via `BasicAuthFilter`)
- SAML/OIDC callback URLs

There is no evidence of IP-based throttling, account lockout after failed attempts, or CAPTCHA. The `LoginUser` entity likely tracks failed login attempts (common in OpenELIS), but this was not confirmed server-side, and no `AccountStatusUserDetailsChecker` equivalent is wired in `SecurityConfig`. A brute-force attack against the form login is unconstrained at the application layer.

---

## P2-L: `DBImageController` — Hardcoded MIME Type

**File:** `src/main/java/org/openelisglobal/image/controller/DBImageController.java` (L19–24)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/image/controller/DBImageController.java#L19-24
@GetMapping(value = "/dbImage/siteInformation/{imageName}")
public IdValuePair getImage(@PathVariable String imageName) {
    ...
    String imageData = "data:image/jpg;base64," + Base64.getEncoder()
            .encodeToString(image.get().getImage());
    return new IdValuePair(imageName, imageData);
}
```

Two issues here:
1. The `{imageName}` path variable is passed to `imageService.getImageBySiteInfoName(imageName)` without validation. If the underlying service queries the DB by this string, an attacker can probe for arbitrary site information values by changing the `imageName` path variable. While likely limited to what the DB query returns, it is an **IDOR (Insecure Direct Object Reference)** risk.
2. The MIME type is hardcoded as `image/jpg` regardless of what the actual stored image format is, meaning a mal
P2-L: `DBImageController` — IDOR + Hardcoded MIME Type *(continued)*

The hardcoded `data:image/jpg;base64,...` prefix means a PNG or GIF stored in the database is returned with an incorrect `image/jpg` MIME type. More critically, if an **SVG** were ever stored (SVGs support embedded JavaScript), the incorrect MIME type claim would still be served — but browser behavior on data URIs with embedded SVGs could allow XSS depending on rendering context. The correct fix is to detect actual image format before constructing the data URI prefix.

---

## P2-M: `@PreAuthorize("hasRole('ADMIN')")` — Dead Security Annotation

### M1 — Method Security Not Enabled in Spring Configuration

**File:** `src/main/java/org/openelisglobal/security/SecurityConfig.java` (L90–92)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/SecurityConfig.java#L90-92
@EnableWebSecurity
@Configuration
public class SecurityConfig {
```

`@EnableWebSecurity` is present, but **`@EnableMethodSecurity` (or the older `@EnableGlobalMethodSecurity`) is nowhere in the codebase**. This means every `@PreAuthorize("hasRole('ADMIN')")` annotation placed in the codebase — including all four on `SiteBrandingRestController` — is **completely ignored at runtime**. The annotations are dead decorations.

Spring MVC method security via `@PreAuthorize` requires `@EnableMethodSecurity` to activate the AOP proxy that intercepts annotated methods. Without it, the annotations compile fine but have zero enforcement effect.

**Confirmed affected endpoints** (all in `SiteBrandingRestController`):
- `PUT /rest/site-branding/` — **no actual role check** despite `@PreAuthorize("hasRole('ADMIN')")`
- `POST /rest/site-branding/logo/{type}` — **no actual role check**
- `DELETE /rest/site-branding/logo/{type}` — **no actual role check**
- `POST /rest/site-branding/reset` — **no actual role check**

**Impact:** Any authenticated user — regardless of role — can modify site branding, upload logo files, delete logos, and reset all branding to defaults. Logo upload combined with the fact that file validation runs server-side but method security does not creates a vector where any clinician account can upload files to the server filesystem.

---

## P2-N: `ExternalPatientSearch` — TLS Certificate Validation Completely Disabled

**File:** `src/main/java/org/openelisglobal/common/externalLinks/ExternalPatientSearch.java` (L185–196)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/common/externalLinks/ExternalPatientSearch.java#L185-196
// Ignore hostname mismatches and allow trust of self-signed certs
// TODO shouldn't let a self signed cert through
SSLSocketFactory sslsf = new SSLSocketFactory(new TrustSelfSignedStrategy(),
        SSLSocketFactory.ALLOW_ALL_HOSTNAME_VERIFIER);
Scheme https = new Scheme("https", 443, sslsf);
ClientConnectionManager ccm = httpclient.getConnectionManager();
ccm.getSchemeRegistry().register(https);
```

This code — which has a `TODO` comment acknowledging it is wrong — configures the Apache HTTP client to:
1. **Trust any self-signed certificate** (`TrustSelfSignedStrategy`), including those of MITM proxies.
2. **Disable hostname verification entirely** (`ALLOW_ALL_HOSTNAME_VERIFIER`), meaning the CN/SAN of the certificate is never checked against the hostname.

This search service sends **patient search queries** containing first name, last name, national ID, subject number, STNumber, and GUID — all PHI — over an HTTPS connection that is completely vulnerable to man-in-the-middle interception. Additionally:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/common/externalLinks/ExternalPatientSearch.java#L301-305
uriFinal = new URIBuilder(uriStart)
    .addParameter(GET_PARAM_FIRST, firstName)
    ...
    .addParameter(GET_PARAM_NAME, connectionName)
    .addParameter(GET_PARAM_PWD, connectionPassword)  // <-- credentials in URL query string
    .build();
```

The **credentials (username + password) are appended as URL query parameters**, meaning they appear in:
- Server access logs on the remote system
- Browser history if triggered via redirect
- HTTP Referer headers passed to subsequent requests
- Proxy logs in cleartext

This is a dual vulnerability: weak TLS + credentials-in-URL.

**Impact:** Patient PHI and service credentials are transmitted in a way that is trivially interceptable by any MITM attacker on the network path, which is a HIPAA Security Rule violation.

---

## P2-O: Mass Assignment Vulnerability — `PropertyUtils.copyProperties` on Entity Objects

**Files:** Multiple patient and organization controllers

**Finding:** `PatientManagementRestController` uses `PropertyUtils.copyProperties(patient, patientInfo)` and `PropertyUtils.copyProperties(patient.getPerson(), patientInfo)` to bulk-copy form bean properties directly onto JPA entity objects:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/patient/controller/rest/PatientManagementRestController.java#L130-133
private void copyFormBeanToValueHolders(PatientManagementInfo patientInfo, Patient patient)
        throws ... {
    PropertyUtils.copyProperties(patient, patientInfo);
    PropertyUtils.copyProperties(patient.getPerson(), patientInfo);
}
```

Apache Commons `PropertyUtils.copyProperties()` performs a **reflective, name-matched copy of all readable-to-writable property pairs**. If `PatientManagementInfo` has any field that matches a sensitive field on the `Patient` entity (e.g., `id`, `sysUserId`, `lastupdated`, `fhir_uuid`), the attacker can override those fields by including them in the request body. While `WebDataBinder.setAllowedFields()` is used in the form-binding path, the REST controller uses `@RequestBody` which bypasses the `WebDataBinder` allowlist entirely — the JSON deserializer populates `PatientManagementInfo` directly, and all its fields are then bulk-copied to `Patient`.

This is the classic **mass assignment / parameter tampering** pattern. If `PatientManagementInfo` exposes a `patientPK` or internal ID field, an attacker could update the wrong patient record (horizontal IDOR) or forge audit trail IDs.

---

## P2-P: `PatientManagementRestController` — Binding Error Silently Swallowed

**File:** `src/main/java/org/openelisglobal/patient/controller/rest/PatientManagementRestController.java` (L72–95)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/patient/controller/rest/PatientManagementRestController.java#L72-95
if (bindingResult.hasErrors()) {
    try {
        throw new BindException(bindingResult);
    } catch (BindException e) {
        LogEvent.logError(e);  // errors logged but...
    }
}
// ...execution continues regardless!
try {
    patientService.persistPatientData(patientInfo, patient, getSysUserId(request));
```

When `bindingResult.hasErrors()` is true (validation failed), a `BindException` is thrown and immediately caught in the same block, effectively doing nothing — the method **continues to persist invalid patient data**. The patient save operation runs even when input validation fails. This means:
- Malformed dates (e.g., `patientLastUpdated`) are passed to `Timestamp.valueOf()` without guarding, which throws `IllegalArgumentException` at runtime.
- Invalid or out-of-range values bypass validation and reach the database layer.
- The HTTP response returns HTTP 200 with no error indication even when data was rejected by validators.

This is both a **data integrity** and **security** issue — an attacker can submit partially invalid data that slips through the broken error handling.

---

## P2-Q: `patient-photos/{id}/{isThumbnail}` — IDOR on Patient Photos

**File:** `src/main/java/org/openelisglobal/patient/controller/rest/PatientManagementRestController.java` (L97–101)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/patient/controller/rest/PatientManagementRestController.java#L97-101
@GetMapping("patient-photos/{id}/{isThumbnail}")
public ResponseEntity<Map<String, String>> getPhoto(@PathVariable String id,
        @PathVariable boolean isThumbnail) throws LIMSRuntimeException {
    String photo = photoService.getPhotoByPatientId(id, isThumbnail);
    return ResponseEntity.ok(Map.of("data", photo));
}
```

The `{id}` path variable is a patient ID passed directly to `photoService.getPhotoByPatientId()`. There is:
- **No check that the requesting user has any relationship to this patient** (e.g., they ordered their test or are their clinician).
- **No role check** — any authenticated user can request any patient's photo by enumerating numeric IDs (`/rest/patient-photos/1/false`, `/rest/patient-photos/2/false`, etc.).

This is a direct **Insecure Direct Object Reference (IDOR)** on a biometric / PHI attribute.

---

## P2-R: Sensitive Data in Debug Logs — `SiteBrandingRestController`

**File:** `src/main/java/org/openelisglobal/sitebranding/controller/rest/SiteBrandingRestController.java`

The controller is saturated with `logger.debug(...)` and `logger.info(...)` calls that log field-by-field object state at every step:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/sitebranding/controller/rest/SiteBrandingRestController.java#L67-78
logger.debug(
    "Retrieved branding: id={}, primaryColor={}, secondaryColor={}, headerColor={}, colorMode={}, useHeaderLogoForLogin={}",
    branding.getId(), branding.getPrimaryColor(), branding.getSecondaryColor(),
    branding.getHeaderColor(), branding.getColorMode(), branding.getUseHeaderLogoForLogin());
...
logger.debug("sysUserId from request: {}", sysUserId);
```

More critically in the logo upload handler:
```OpenELIS-Global-2/src/main/java/org/openelisglobal/sitebranding/controller/rest/SiteBrandingRestController.java#L224-226
logger.debug("File details: name={}, size={} bytes, contentType={}", 
    file.getOriginalFilename(), file.getSize(), file.getContentType());
...
logger.info("Logo uploaded successfully: type={}, filePath={}, fileName={}, fileSize={}", 
    logoType, filePath, file.getOriginalFilename(), file.getSize());
```

The `filePath` is logged in full — revealing the **absolute server filesystem path** of where uploaded files are stored. If logging is elevated to DEBUG (trivially achievable via `LoggingController` as shown in P2-C3), these paths become visible in log aggregation systems, facilitating targeted path traversal or file read attacks. This is also an example of the "AI slop" quality smell: the excessive, narrating debug logs read like scaffolding from a development iteration rather than intentional production diagnostics.

---

## P2-S: `OclZipImporter` — Zip Slip Vulnerability

**File:** `src/main/java/org/openelisglobal/ocl/OclZipImporter.java` (L47–79)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/ocl/OclZipImporter.java#L47-79
zipFile.stream().forEach(entry -> {
    try {
        if (entry.isDirectory()) { return; }
        if (entry.getName().endsWith(".json")) {
            node = parseJsonEntry(zipFile, entry);
        }
        ...
    }
```

The code iterates ZIP entries and checks only that they end with `.json` — but it **never validates `entry.getName()` for path traversal**. A maliciously crafted ZIP file with an entry named `../../webroot/malicious.json` or `../../../etc/cron.d/attack.json` would have `entry.getName()` return that path, and if any code above this layer wrote the entry to disk, it would escape the intended directory. While this importer only **reads** the ZIP and parses JSON (no `transferTo` call here), the `entry.getName()` is logged (`log.info("Processing ZIP entry: {}", entry.getName())`), which means a specially crafted ZIP entry name could inject CRLF characters into log files (log injection), creating false audit trail entries.

Furthermore, the `OclImportInitializer` that invokes this importer reads from `configurations/ocl` — a directory path. If that directory is user-writable (e.g., mounted volume), a malicious ZIP placed there would be automatically imported on startup, providing a persistence mechanism.

---

## P2-T: Session Management — No Concurrent Session Control

**File:** `src/main/java/org/openelisglobal/security/SecurityConfig.java` (L400–431)

The `defaultSecurityConfigurationFilterChain` sets `.sessionFixation().migrateSession()` (correct) and `.invalidSessionUrl("/LoginPage")` (correct). However, there is **no `.sessionManagement().maximumSessions(1)` limit** configured. This means:
- A single user account can have an unlimited number of concurrent active sessions across multiple browsers/devices.
- If a session token is stolen (e.g., via the session ID leak from Phase 1's A-1 finding), the victim cannot detect or terminate the attacker's session by logging in again.
- There is no `sessionRegistry()` integration that would allow admins to see and invalidate active sessions.

**Impact:** Stolen session tokens remain valid indefinitely until timeout, and there is no mechanism for users or admins to force session expiry on compromise.

---

## Phase 2 Consolidated Risk Register

| ID | Title | Area | Severity | OWASP / Standard |
|----|-------|------|----------|-------------------|
| P2-A1 | Patient search returns PHI with no role check | BOLA / AuthZ | 🔴 Critical | OWASP A01 |
| P2-A2 | Audit trail readable by any authenticated user | AuthZ | 🔴 Critical | OWASP A01, ISO 15189 |
| P2-A3 | All system users enumerable via `/rest/users` | Info Disclosure | 🟠 High | OWASP A01 |
| P2-B1 | Mass patient data deletion gated only on config property | AuthZ | 🔴 Critical | OWASP A01 |
| P2-C1 | `/import/**` endpoints unguarded — mass FHIR import | AuthZ | 🟠 High | OWASP A01 |
| P2-C2 | `/rest/reindex` causes DoS with no rate limit or auth | DoS / AuthZ | 🟠 High | OWASP A01 |
| P2-C3 | `/logging` endpoint allows any user to toggle PHI logging | Privilege Escalation | 🔴 Critical | OWASP A01 |
| P2-D1 | FHIR endpoint: arbitrary resource type + param injection | IDOR / Injection | 🔴 Critical | OWASP A01, OWASP A03 |
| P2-D2 | FHIR resource ID unvalidated — path traversal risk | IDOR | 🟠 High | OWASP A01 |
| P2-E1 | Logo upload: `.contains()` not `.endsWith()` for extension | File Upload | 🟠 High | OWASP A03 |
| P2-E2 | Analyzer import: filename-controlled reader, no MIME check | File Upload | 🟠 High | OWASP A03 |
| P2-E3 | Generic sample import trusts client MIME type | File Upload | 🟡 Medium | OWASP A03 |
| P2-F1 | Hard-coded `sysUserId = "1"` in audit trail writes | Audit Integrity | 🔴 Critical | ISO 15189, SLIPTA |
| P2-G1 | Country-specific password policy — "HAITI" only 7 chars | Password Policy | 🟠 High | OWASP A07 |
| P2-G2 | Password generation via String concat leaks in JVM heap | Crypto | 🟡 Medium | OWASP A02 |
| P2-H1 | External connection password in URL query string + String heap | Credential Exposure | 🔴 Critical | OWASP A02 |
| P2-I1 | Report name from request body passed to factory with no allowlist | Injection | 🟠 High | OWASP A03 |
| P2-J1 | Analyzer SSRF: private ranges allowed — reaches internal services | SSRF | 🟠 High | OWASP A10 |
| P2-L1 | DBImageController: IDOR on image name path variable | IDOR | 🟡 Medium | OWASP A01 |
| P2-M1 | `@EnableMethodSecurity` missing — all `@PreAuthorize` annotations dead | AuthZ | 🔴 Critical | OWASP A01 |
| P2-N1 | External patient search: TLS disabled + credentials in URL | TLS / Credential | 🔴 Critical | OWASP A02, HIPAA |
| P2-O1 | Mass assignment via `PropertyUtils.copyProperties` on entity | Mass Assignment | 🟠 High | OWASP A03 |
| P2-P1 | Patient save binding errors silently swallowed — save continues | Data Integrity | 🟠 High | OWASP A04 |
| P2-Q1 | Patient photos IDOR — no ownership or role check | IDOR / PHI | 🔴 Critical | OWASP A01 |
| P2-R1 | Full server file path logged in branding controller | Info Disclosure | 🟡 Medium | OWASP A09 |
| P2-S1 | Zip Slip in OCL importer — log injection risk | Injection | 🟡 Medium | OWASP A03 |
| P2-T1 | No concurrent session limits — stolen tokens persist | Session Mgmt | 🟠 High | OWASP A07 |

---

## Phase 2 — Top Priority Remediation Targets

### 🔴 Must Fix Immediately (Critical)

**1. Enable `@EnableMethodSecurity` (P2-M1)**
Add `@EnableMethodSecurity(prePostEnabled = true)` to `SecurityConfig`. Without this, every `@PreAuthorize` annotation across the entire application is inert. This single change activates authorization for all annotated methods.

**2. Add role checks to audit trail, patient photos, and patient search (P2-A1, P2-A2, P2-Q1)**
Apply programmatic role checks (`hasGlobalAdminRole()` pattern already used in `PatientMergeRestController`) or use `@PreAuthorize` (once P2-M1 is fixed) on all PHI-returning endpoints.

**3. Fix the logging controller (P2-C3)**
Gate `/logging` and `/logging/test` to `ROLE_GLOBAL_ADMIN` only. Attacker-controlled log level changes on a healthcare system are catastrophically dangerous for audit trail integrity and PHI exposure.

**4. Fix hard-coded sysUserId "1" (P2-F1)**
Pass the real system user context through all async/batch operations. For headless operations (file watchers, result reporting), create a dedicated service account ID and configure it through properties, not hard-coded in code.

**5. Fix `ExternalPatientSearch` TLS (P2-N1)**
Remove `TrustSelfSignedStrategy` and `ALLOW_ALL_HOSTNAME_VERIFIER`. Migrate to a proper `SSLContext` using the application's `TruststoreService`. Move credentials from URL query parameters to `Authorization: Basic` headers.

**6. Restrict FHIR endpoints (P2-D1, P2-D2)**
Add a FHIR resource type allowlist (`Patient`, `ServiceRequest`, `Observation`, `DiagnosticReport`, `Questionnaire`, `QuestionnaireResponse`) and validate `resourceType` against `org.hl7.fhir.r4.model.ResourceType`. Add a HAPI `AuthorizationInterceptor` to the local FHIR client configuration.

### 🟠 Fix in Next Sprint (High)

- **P2-B1**: Add `isUserAdmin` check to `DeletePatientTestDataController` in addition to the config property guard.
- **P2-C1**: Add `ROLE_GLOBAL_ADMIN` check to all `/import/**` endpoints.
- **P2-C2**: Gate `/rest/reindex` to `ROLE_GLOBAL_ADMIN` and add a simple cooldown lock (e.g., prevent re-entry within 5 minutes).
- **P2-E1**: Fix file extension check from `.contains()` to `.endsWith()` (case-insensitive). Consider checking actual magic bytes not just extension.
- **P2-O1**: Replace `PropertyUtils.copyProperties(patient, patientInfo)` with explicit field-by-field mapping to prevent mass assignment on entities.
- **P2-P1**: Fix the swallowed-exception pattern in `savepatient()` — return an error response and stop execution when `bindingResult.hasErrors()` is true.
- **P2-J1**: If SSRF to internal services is a concern, add a configurable allowlist of permitted analyzer IP ranges rather than allowing all private RFC-1918 addresses.

### 🟡 Fix in Near Term (Medium)

- **P2-G1**: Standardize all deployments to a single, strong password policy (minimum 10 chars, 3 of 4 complexity categories). The country-branching approach violates the constitutional principle of configuration-driven variation.
- **P2-G2**: Rewrite `generatePassword()` to use `char[]` and zero it after use; use `StringBuilder` → `char[]` → zero after BCrypt hash.
- **P2-R1**: Remove or restructure the excessive `logger.debug` calls in `SiteBrandingRestController` that expose file system paths. Use structured logging without leaking internal paths.
- **P2-S1**: Add `entry.getName()` path traversal validation in `OclZipImporter` (check that canonical path starts within intended target directory).
- **P2-T1**: Configure `.maximumSessions(1).maxSessionsPreventsLogin(false)` with `sessionRegistry()` in `SecurityConfig` to invalidate older sessions when a new login occurs, and to enable admin session management.

---

## Cross-Cutting Observation: No Method Security = Systematic AuthZ Failure

The most architecturally significant finding of Phase 2 is **P2-M1**: the absence of `@EnableMethodSecurity` means that any endpoint that relies solely on `@PreAuthorize` for access control has **zero enforcement**. This makes it impossible to audit "which endpoints are secured" by reading the annotations alone — the actual runtime behavior diverges completely from what the code appears to promise. Any future `@PreAuthorize` annotations added by developers will also be silently unenforced until this is corrected. This single gap represents a systematic authorization architecture failure that amplifies the impact of every other missing role check found in this audit.
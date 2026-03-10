Phase 3 Security Audit — PHI Data Exposure

This is a deep, evidence-based audit of Protected Health Information (PHI) data exposure across OpenELIS Global 2. Every finding below is grounded in specific file paths and line numbers from the live codebase.

---

## Audit Scope & Methodology

The audit focused on the third stage in our sequence: **PHI data exposure**. Specifically:

1. REST endpoints that return patient demographics, results, or identifiers
2. Authorization guards (or lack thereof) on those endpoints
3. PHI leakage into logs and error responses
4. Audit trail access controls
5. Photo/biometric data access
6. Systemic amplifiers (missing `@EnableMethodSecurity`, CSRF blanket-disable, sysUserId hardcoding)

---

## P3-A: Patient Search Endpoints — No Role-Level Access Control

### P3-A1 — `/rest/patient-search-results` exposes full PHI to any authenticated user

```OpenELIS-Global-2/src/main/java/org/openelisglobal/common/rest/provider/PatientSearchRestController.java#L70-125
@GetMapping(value = "patient-search-results", produces = MediaType.APPLICATION_JSON_VALUE)
@ResponseBody
public PatientSearchResultsForm getPatientResults(HttpServletRequest request,
        @RequestParam(required = false) String lastName,
        @RequestParam(required = false) String firstName,
        ...
        @RequestParam(required = false) String nationalID,
        @RequestParam(required = false) String dateOfBirth,
        ...
```

**No `@PreAuthorize`, no role check, no ownership check.** `SecurityConfig` maps all `/rest/**` to "authenticated only" (`anyRequest().authenticated()`). The result payload includes: `firstName`, `lastName`, `nationalId`, `dateOfBirth`, `gender`, `STNumber`, `subjectNumber`, `GUID`, and `referringSitePatientId`. Any authenticated user — even a receptionist or read-only viewer — can harvest the full patient demographic database by iterating last-name searches.

### P3-A2 — `/rest/patient-search` (second endpoint) — identical gap

```OpenELIS-Global-2/src/main/java/org/openelisglobal/common/rest/provider/PatientSearchRestController.java#L160-169
@GetMapping("/patient-search")
public @ResponseBody List<PatientSearchResults> getSearchResults(
        @RequestParam(required = false) String lastName,
        @RequestParam(required = false) String firstName,
        ...
        @RequestParam(required = false) String nationalID,
        @RequestParam(required = false) String patientID,
        ...
```

This is a **second unchecked PHI endpoint**, distinct from `patient-search-results`, returning the same demographic fields. No guard whatsoever.

### P3-A3 — `/rest/patient-details` returns full patient profile by internal DB ID

```OpenELIS-Global-2/src/main/java/org/openelisglobal/common/rest/provider/PatientSearchPopulateRestController.java#L53-64
@GetMapping(value = "patient-details", produces = MediaType.APPLICATION_JSON_VALUE)
@ResponseBody
public PatientInfoBean getPatientResults(@RequestParam String patientID) {
    if (!GenericValidator.isBlankOrNull(patientID)) {
        return getPatientDetails(getPatientForID(patientID));
    } else {
        return new PatientInfoBean();
    }
}
```

**Accepts a raw internal DB primary key.** The response payload includes: `nationalId`, `STnumber`, `subjectNumber`, `lastName`, `firstName`, `mothersName`, `aka`, `streetAddress`, `city`, `primaryPhone`, `email`, `gender`, `birthDate`, `commune`, `addressDepartment`, `mothersInitial`, `education`, `maritialStatus`, `nationality`, `healthDistrict`, `healthRegion`, `insuranceNumber`, `occupation`, and full `patientContact`. This is the most complete PHI object in the API. **No role check, no ownership check.** ID enumeration attack: increment `patientID` from 1 to N to harvest all records.

---

## P3-B: Audit Trail REST Endpoint Fully Unguarded

```OpenELIS-Global-2/src/main/java/org/openelisglobal/audittrail/controller/rest/AuditTrailReportRestController.java#L13-35
@RestController
public class AuditTrailReportRestController {

    @GetMapping("/rest/AuditTrailReport")
    public ResponseEntity<AuditTrailViewForm> getAuditTrailReport(@RequestParam String accessionNumber) {
        ...
        response.setLog(items);
        response.setSampleOrderItems(worker.getSampleOrderSnapshot());
        response.setPatientProperties(worker.getPatientSnapshot());
        return ResponseEntity.ok(response);
    }
}
```

**Zero authorization.** The response contains: the full audit log of every field change on the sample, `SampleOrderItem` (which contains requester/provider info), and `PatientManagementInfo` (which is the same full PHI profile as P3-A3). Any authenticated user can read the complete change history of any sample by providing its accession number.

---

## P3-C: Patient Photo Endpoint — No Ownership Check

```OpenELIS-Global-2/src/main/java/org/openelisglobal/patient/controller/rest/PatientManagementRestController.java#L97-104
@GetMapping("patient-photos/{id}/{isThumbnail}")
public ResponseEntity<Map<String, String>> getPhoto(@PathVariable String id, @PathVariable boolean isThumbnail)
        throws LIMSRuntimeException {
    String photo = photoService.getPhotoByPatientId(id, isThumbnail);
    return ResponseEntity.ok(Map.of("data", photo));
}
```

**No role check, no session-to-patient binding, no ownership verification.** The `{id}` is the patient's internal DB ID. Combined with P3-A3 (enumerate patientIDs), an attacker can extract base64-encoded facial photos of any patient in the database. This is biometric PHI and carries heightened regulatory risk (HIPAA/ISO 15189).

---

## P3-D: Dashboard Endpoints Expose Patient National IDs Without Any Authorization

```OpenELIS-Global-2/src/main/java/org/openelisglobal/common/rest/provider/PatientDashBoardProvider.java#L300-302
@GetMapping(value = "home-dashboard/metrics", produces = MediaType.APPLICATION_JSON_VALUE)
@ResponseBody
public DashBoardMetrics getDasBoardTiles() {
```

```OpenELIS-Global-2/src/main/java/org/openelisglobal/common/rest/provider/PatientDashBoardProvider.java#L378-381
@GetMapping(value = "home-dashboard/{listType}", produces = MediaType.APPLICATION_JSON_VALUE)
@ResponseBody
public PatientDashBoardForm getDashBoardDisplayList(...)
```

The order beans built in `convertAnalysesToOrderBean` embed `patient.getNationalId()`:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/common/rest/provider/PatientDashBoardProvider.java#L194-198
orderBean.setPatientId(sampleHumanService.getPatientForSample(sample).getNationalId());
```

And `convertElectronicToOrderBean` does the same:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/common/rest/provider/PatientDashBoardProvider.java#L291-294
orderBean.setPatientId(eOrder.getPatient().getNationalId());
```

Dashboard responses leak national IDs for every order currently in the system, accessible to any role.

---

## P3-E: PHI Logged in Plain Text — Log-Based PHI Leakage

### E1 — Patient names and national IDs logged at INFO level

```OpenELIS-Global-2/src/main/java/org/openelisglobal/common/rest/provider/PatientSearchRestController.java#L218-224
LogEvent.logInfo("PatientSearchRestController", "searchPatientInClientRegistry",
        String.format("Skipped duplicate patient with NationalId: %s, Name: %s %s",
                transformedPatientSearchResult.getNationalId(),
                transformedPatientSearchResult.getFirstName(),
                transformedPatientSearchResult.getLastName()));
```

**Full name + national ID written to application logs.** Logs are frequently shipped to centralized log aggregation (ELK, Splunk, CloudWatch). PHI in logs violates HIPAA minimum-necessary and ISO 15189 data protection requirements.

### E2 — Dynamic national ID written to INFO log

```OpenELIS-Global-2/src/main/java/org/openelisglobal/common/rest/provider/PatientSearchRestController.java#L207-211
LogEvent.logInfo(this.getClass().getSimpleName(), "searchPatientInClientRegistry",
        "dynamic national id: " + nationalId);
```

Generated identifiers (derived from DOB + gender + initials) are also written verbatim to logs. This is a derived PHI identifier.

### E3 — `System.out.println` debug noise in production code path (NCE controller)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/qaevent/controller/rest/NonConformingEventsCorrectionActionRestController.java#L52-56
System.out.println("search Results Size" + searchResults.size());
```

While not directly PHI, this confirms debug-level output is reaching `stdout` in production — a pattern that when replicated elsewhere (e.g., analyzer plugins — `System.out.print("******* line:"+i)`) can expose data if log redirection is misconfigured.

---

## P3-F: Import Controller — Unauthenticated FHIR Mass Import

```OpenELIS-Global-2/src/main/java/org/openelisglobal/admin/controller/ImportController.java#L13-50
@RestController
@RequestMapping("/import")
public class ImportController {

    @GetMapping(value = "/all")
    public void importAll() throws ... {
        importDataFromFhir(ResourceType.ORGANIZATION);
        importDataFromFhir(ResourceType.PROVIDER);
    }
    @GetMapping(value = "/organization")
    ...
    @GetMapping(value = "/provider")
    ...
}
```

The `/import` path is **not** covered by `REST_CONTROLLERS = { "/Provider/**", "/rest/**" }` in `SecurityConfig`. The `defaultSecurityConfigurationFilterChain` catches everything else as `anyRequest().authenticated()` — so basic authentication is required — **but there is no admin role gate**. Any authenticated user (including lab staff with no admin privilege) can trigger a mass FHIR import of organizations and providers, which is a data-integrity and write-PHI risk.

---

## P3-G: `/rest/users` — User Enumeration, No Role Gate

```OpenELIS-Global-2/src/main/java/org/openelisglobal/systemuser/controller/rest/UnifiedSystemUserRestController.java#L133-147
@GetMapping(value = "/users")
@ResponseBody
public List<IdValuePair> getUsersWithRole() {
    List<SystemUser> users = systemUserService.getAll();
    List<IdValuePair> idValues = users.stream()
            .map(e -> new IdValuePair(e.getId(), e.getDisplayName()))
            .collect(Collectors.toList());
    return idValues;
}

@GetMapping(value = "/users/{roleName}")
@ResponseBody
public List<IdValuePair> getUsersWithRole(@PathVariable String roleName) {
    List<SystemUser> users = systemUserService.getAll();
    return users.stream().filter(e -> userRoleService.userInRole(e.getId(), roleName))...
```

**All system users and their role memberships exposed to any authenticated user.** The `/users/{roleName}` variant allows enumeration of which users hold `Admin`, `Validator`, `Results`, and other high-privilege roles — facilitating targeted phishing or social engineering attacks.

---

## P3-H: Hardcoded `sysUserId = "1"` — Audit Trail Integrity Corruption

This pattern is widespread across the codebase:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/common/service/servlet/reports/LogoUploadServiceImpl.java#L21-26
logoInformation.setSysUserId("1");
siteInformationService.update(logoInformation);
```

```OpenELIS-Global-2/src/main/java/org/openelisglobal/analyzer/service/AnalyzerFieldMappingServiceImpl.java#L368-372
mapping.setSysUserId("1"); // Default system user (should come from security context)
```

```OpenELIS-Global-2/src/main/java/org/openelisglobal/analyzer/service/AnalyzerMappingCopyServiceImpl.java#L130-134
newMapping.setSysUserId("1"); // Default system user
```

Found in: `AnalyzerServiceImpl`, `AnalyzerTypeServiceImpl`, `AnalyzerQueryServiceImpl`, `AnalyzerFieldMappingServiceImpl`, `AnalyzerMappingCopyServiceImpl`, `PluginRegistryService`, `PluginPermissionService`, `PluginAnalyzerService`, `LogoUploadServiceImpl`, `MalariaSurveilanceJob`, `AggregateReportJob`. **At least 15+ call sites.** All audit trail entries for these operations are attributed to a phantom "system user 1" rather than the real acting user. This destroys non-repudiation, a core ISO 15189 compliance requirement.

---

## P3-I: `@EnableMethodSecurity` Not Present — All `@PreAuthorize` Annotations Are Dead

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/SecurityConfig.java#L92-555
public class SecurityConfig { ... }
```

`SecurityConfig` has no `@EnableMethodSecurity(prePostEnabled = true)` annotation. This means **every** `@PreAuthorize` annotation in the codebase is silently ignored at runtime. Method-level security declarations appear in several controllers but are completely inoperative, creating a false sense of security.

---

## P3-J: CSRF Disabled for All `/rest/**` — PHI Write Endpoints Vulnerable

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/SecurityConfig.java#L424-427
.csrf(csrf -> csrf.ignoringRequestMatchers("/ValidateLogin", "/rest/**",
        "/api/OpenELIS-Global/rest/**"))
```

**All REST endpoints, including PHI-writing ones** (`/rest/PatientManagement`, `patient-photos/{id}`, etc.), have CSRF protection globally disabled. A malicious page visited by an authenticated lab staff member can forge cross-site requests to create, modify, or delete patient records. This amplifies every PHI write surface.

---

## P3-K: Mass Assignment Risk — `PropertyUtils.copyProperties` on Patient Entity

```OpenELIS-Global-2/src/main/java/org/openelisglobal/patient/controller/rest/PatientManagementRestController.java#L120-125
private void copyFormBeanToValueHolders(PatientManagementInfo patientInfo, Patient patient)
        throws IllegalAccessException, InvocationTargetException, NoSuchMethodException {
    PropertyUtils.copyProperties(patient, patientInfo);
    PropertyUtils.copyProperties(patient.getPerson(), patientInfo);
}
```

`PropertyUtils.copyProperties` performs a **bulk reflection-based copy of all same-named properties** from the form DTO to the entity. If `PatientManagementInfo` ever gains a field that shadows a sensitive entity field (e.g., `id`, `sysUserId`, `fhirUuid`, `lastUpdated`), a crafted request body can overwrite it. There is no explicit whitelist of copyable fields at the property-copy layer; the protection relies entirely on `@Validated` at the controller parameter — which only validates, not filters, property names.

---

## Risk Register — Phase 3

| ID | Surface | Finding | Severity | HIPAA/ISO 15189 Impact |
|---|---|---|---|---|
| **P3-A1** | `GET /rest/patient-search-results` | Full PHI search, no role gate | 🔴 Critical | PHI disclosure to all staff |
| **P3-A2** | `GET /rest/patient-search` | Second unchecked PHI search endpoint | 🔴 Critical | PHI disclosure to all staff |
| **P3-A3** | `GET /rest/patient-details?patientID=` | Full patient profile by DB ID, ID-enumerable | 🔴 Critical | PHI harvest via integer enumeration |
| **P3-B** | `GET /rest/AuditTrailReport` | Full audit trail + patient PHI, no role gate | 🔴 Critical | Data integrity + PHI disclosure |
| **P3-C** | `GET /rest/patient-photos/{id}` | Biometric photo, no ownership or role check | 🔴 Critical | Biometric PHI exposure |
| **P3-D** | `GET /rest/home-dashboard/**` | National IDs in dashboard responses, no role check | 🟠 High | PHI leakage in aggregate view |
| **P3-E1** | `PatientSearchRestController` logs | Names + national IDs written to INFO logs | 🟠 High | Log-based PHI exposure |
| **P3-E2** | `PatientSearchRestController` logs | Derived national ID in INFO logs | 🟡 Medium | Derived PHI in logs |
| **P3-F** | `POST /import/{all,organization,provider}` | Mass FHIR import, no admin gate | 🟠 High | Unauthorized data write |
| **P3-G** | `GET /rest/users`, `/rest/users/{roleName}` | Full user + role enumeration | 🟠 High | Privilege mapping for attackers |
| **P3-H** | 15+ service call sites | `sysUserId = "1"` destroys audit integrity | 🟠 High | Non-repudiation lost |
| **P3-I** | `SecurityConfig` | `@EnableMethodSecurity` absent — all `@PreAuthorize` inert | 🔴 Critical | All method-security annotations are no-ops |
| **P3-J** | `SecurityConfig` | CSRF disabled for all `/rest/**` | 🟠 High | PHI write CSRF forgery |
| **P3-K** | `PatientManagementRestController` | `PropertyUtils.copyProperties` mass assignment | 🟡 Medium | Entity field takeover risk |

---

## Concrete Remediation Patches

### Fix P3-I First — Enable Method Security (Foundational)

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/SecurityConfig.java#L88-92
@Configuration
@EnableWebSecurity
@EnableMethodSecurity(prePostEnabled = true)   // ← ADD THIS
public class SecurityConfig {
```

This single line activates all `@PreAuthorize` annotations across the codebase and is the prerequisite for the fixes below.

### Fix P3-A1/A2/A3 — Add `@PreAuthorize` to Patient Search Endpoints

```OpenELIS-Global-2/src/main/java/org/openelisglobal/common/rest/provider/PatientSearchRestController.java#L70-73
@GetMapping(value = "patient-search-results", produces = MediaType.APPLICATION_JSON_VALUE)
@ResponseBody
// ADD:
@PreAuthorize("hasAnyRole('ROLE_RECEPTION','ROLE_RESULTS','ROLE_VALIDATION','ROLE_GLOBAL_ADMIN')")
public PatientSearchResultsForm getPatientResults(...)
```

Apply the same to `patient-search` and `patient-details`. The `patient-details` endpoint additionally needs **input validation** — reject non-numeric `patientID` and add a session-context ownership check where the role requires it.

### Fix P3-B — Guard Audit Trail Endpoint

```OpenELIS-Global-2/src/main/java/org/openelisglobal/audittrail/controller/rest/AuditTrailReportRestController.java#L13-17
@RestController
// ADD:
@PreAuthorize("hasAnyRole('ROLE_VALIDATION','ROLE_GLOBAL_ADMIN')")
public class AuditTrailReportRestController {
```

Only validators and admins should see full audit trails with embedded patient snapshots.

### Fix P3-C — Enforce Role + Ownership on Photo Endpoint

```OpenELIS-Global-2/src/main/java/org/openelisglobal/patient/controller/rest/PatientManagementRestController.java#L97-104
@GetMapping("patient-photos/{id}/{isThumbnail}")
@PreAuthorize("hasAnyRole('ROLE_RECEPTION','ROLE_GLOBAL_ADMIN')")   // ADD
public ResponseEntity<Map<String, String>> getPhoto(@PathVariable String id, @PathVariable boolean isThumbnail)
        throws LIMSRuntimeException {
    // ADD: verify caller has access to this patient (e.g., via sample ownership or lab unit)
    String photo = photoService.getPhotoByPatientId(id, isThumbnail);
    return ResponseEntity.ok(Map.of("data", photo));
}
```

### Fix P3-E — Remove PHI from Logs

Replace:
```OpenELIS-Global-2/src/main/java/org/openelisglobal/common/rest/provider/PatientSearchRestController.java#L218-224
LogEvent.logInfo("PatientSearchRestController", "searchPatientInClientRegistry",
        String.format("Skipped duplicate patient with NationalId: %s, Name: %s %s",
                transformedPatientSearchResult.getNationalId(),
                transformedPatientSearchResult.getFirstName(),
                transformedPatientSearchResult.getLastName()));
```

With:
```/dev/null/fix.java#L1-5
// FIXED: No PHI in logs — use opaque identifiers only
LogEvent.logInfo("PatientSearchRestController", "searchPatientInClientRegistry",
        String.format("Skipped duplicate patient (GUID: %s)",
                transformedPatientSearchResult.getGUID()));
```

Apply same to dynamic national ID log line (P3-E2).

### Fix P3-F — Gate Import Endpoints to Admin Role

```OpenELIS-Global-2/src/main/java/org/openelisglobal/admin/controller/ImportController.java#L13-16
@RestController
@RequestMapping("/import")
@PreAuthorize("hasRole('ROLE_GLOBAL_ADMIN')")   // ADD at class level
public class ImportController {
```

### Fix P3-G — Gate User Enumeration Endpoints

```OpenELIS-Global-2/src/main/java/org/openelisglobal/systemuser/controller/rest/UnifiedSystemUserRestController.java#L133-140
@GetMapping(value = "/users")
@PreAuthorize("hasRole('ROLE_GLOBAL_ADMIN')")   // ADD
public List<IdValuePair> getUsersWithRole() { ... }

@GetMapping(value = "/users/{roleName}")
@PreAuthorize("hasRole('ROLE_GLOBAL_ADMIN')")   // ADD
public List<IdValuePair> getUsersWithRole(@PathVariable String roleName) { ... }
```

### Fix P3-H — Thread Security Context Through Services

Replace the 15+ hardcoded `"1"` sites with a `SecurityContextHolder`-based utility:

```/dev/null/SecurityUtil.java#L1-12
// New helper to replace setSysUserId("1"):
public static String getCurrentSysUserId() {
    Authentication auth = SecurityContextHolder.getContext().getAuthentication();
    if (auth != null && auth.getPrincipal() instanceof UserSessionData) {
        return String.valueOf(((UserSessionData) auth.getPrincipal()).getSystemUserId());
    }
    return "1"; // fallback for scheduled/system tasks only — log a warning
}
```

For **scheduled jobs** (Malaria, AggregateReport) where there is no user context, use a dedicated named system account rather than hardcoded `"1"`, and document it explicitly.

### Fix P3-J — Tighten CSRF Exclusion Scope

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/SecurityConfig.java#L424-427
// CURRENT — too broad:
.csrf(csrf -> csrf.ignoringRequestMatchers("/ValidateLogin", "/rest/**", "/api/OpenELIS-Global/rest/**"))

// FIXED — only exempt stateless/token-authenticated surfaces:
.csrf(csrf -> csrf.ignoringRequestMatchers(
        "/ValidateLogin",
        "/rest/fhir/**",          // FHIR clients use token auth
        "/pluginServlet/**"       // analyzer plugin callbacks
))
```

All session-cookie-based REST endpoints that write PHI should have CSRF protection re-enabled.

---

## Phase 3 Conclusion

Phase 3 reveals a **systemic PHI exposure posture** driven by three root causes:

1. **Authorization is authentication-only.** `SecurityConfig` treats "logged in" as sufficient for all `/rest/**`. Role-level RBAC is neither enforced by security configuration nor by method annotations (P3-I makes those inert).

2. **Additive PHI accumulation in responses.** Several endpoints were built for convenience and progressively enriched with PHI fields (`patient-details`, `AuditTrailReport`, dashboard beans) without corresponding tightening of access controls.

3. **Log hygiene was never established.** PHI strings flow into log calls as directly-interpolated values, with no masking convention or log-level discipline.

The highest-urgency items to patch before next release are: **P3-I** (enable method security) → **P3-A1/A2/A3** (patient search RBAC) → **P3-B** (audit trail guard) → **P3-C** (photo ownership check) → **P3-E** (PHI out of logs). The remaining items (P3-F, P3-G, P3-H, P3-J, P3-K) should follow in the same sprint as they compound the blast radius of the critical gaps.

---

Ready to move to **Phase 4: FHIR Endpoint Security** when you are. That phase will audit `/rest/fhir/**`, the HAPI FHIR servlet surface, resource type allowlisting, FHIR AuthorizationInterceptor absence, and SSRF via FHIR client connections.
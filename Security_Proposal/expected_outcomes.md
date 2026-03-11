# GSoC 2025 — Expected Outcomes Coverage
# OpenELIS Global 2 Security Hardening Project

This document maps the five expected project outcomes to concrete deliverables. For each
outcome it describes what the five-phase audit already addresses and what additional work
is planned to fully satisfy the requirement. Everything here is grounded in the actual
codebase — no generic recommendations.

---

## Outcome 1 — Comprehensive Security Audit Report

> *Detailing threat models, identified vulnerabilities, risk severity, and recommended
> mitigations.*

### What the five-phase audit already covers

The audit spans 36 distinct vulnerabilities across five layers of the stack. Every
finding is tied to a specific file, a specific line number, and a specific exploit path.
Each phase has its own risk register with CVSS-aligned severity ratings.

| Phase | Layer | Findings |
|-------|-------|---------|
| Phase 1 | Authentication & Session | 6 (P1-A1 through P1-A6) |
| Phase 2 | Broken Access Control & Admin Endpoints | 10 (P2-A1 through P2-E2) |
| Phase 3 | PHI Data Exposure | 11 (P3-A through P3-K) |
| Phase 4 | FHIR Endpoint Security | 5 (P4-A through P4-E) |
| Phase 5 | Infrastructure & Secrets | 10 (P5-A through P5-J) |

### What is still needed — STRIDE threat model in the audit report itself

The STRIDE analysis currently lives only in `phase1_detailed.md`. To satisfy this
outcome fully, a unified STRIDE threat model covering all five layers will be written
as a standalone section of the final audit report deliverable (see Deliverable D1 below).

### Deliverable D1 — Final Security Audit Report

A single consolidated document, `Security_Audit_Report_Final.md`, to be produced by
the end of Week 13 and refined during the buffer week. It will contain:

**1. Executive Summary**
One page. The five root architectural patterns that cause most of the findings:
- Fail-open authorization design (`ModuleAuthenticationInterceptor`)
- Development defaults bleeding into production (hardcoded credentials, TRACE logging)
- Single-layer CORS with no trusted origin list (combined with blanket CSRF exemption)
- No integrity boundary on external inputs (unsigned JARs, unvalidated FHIR paths, file uploads)
- Duplicated and inconsistent authorization logic (module interceptor vs. `@PreAuthorize` vs. empty `getGrantedAuthorities()`)

**2. STRIDE Threat Model — Full Stack**

| STRIDE | Threat | Component | Finding ID | Severity |
|--------|--------|-----------|------------|---------|
| Spoofing | Forge audit-log IP via `X-Forwarded-For` | `CustomFormAuthenticationSuccessHandler` | P1-A2 | Medium |
| Spoofing | SAML IdP provisions attacker with admin sysUserId | `CustomSSOAuthenticationSuccessHandler` | P1-A4 | High |
| Spoofing | Default admin password allows impersonation | All Compose files | P1-A3 | High |
| Spoofing | Hardcoded DB credential `clinlims` = username | `docker-compose.yml` | P5-A | Critical |
| Tampering | Unsigned JAR in plugins volume → RCE | `PluginLoader` | P5-J | Critical |
| Tampering | Any user injects push notifications to any other user | `NotificationRestController` | P2-C3 | High |
| Tampering | Mass patient deletion via config flag bypass | `DeletePatientTestDataController` | P2-B1 | Critical |
| Tampering | CORS origin reflection + CSRF exemption → cross-origin PHI write | `CORSFilter`, `SecurityConfig` | P1-A6, P3-J | Critical |
| Tampering | `PropertyUtils.copyProperties` mass assignment on patient entity | `PatientManagementRestController` | P3-K | Medium |
| Repudiation | Forged `X-Forwarded-For` destroys forensic audit trail | Auth handlers | P1-A2 | Medium |
| Repudiation | `sysUserId = "1"` in 15+ services destroys non-repudiation | Multiple service files | P3-H | High |
| Repudiation | HAPI FHIR access log disabled | `hapi_server.xml` | P5-G | Medium |
| Information Disclosure | JSESSIONID serialised into JSON body, polled every 3s | `LoginPageController` | P1-A1 | High |
| Information Disclosure | Patient name + national ID in INFO logs | `PatientSearchRestController` | P3-E | High |
| Information Disclosure | Hibernate TRACE logs write PHI to disk by default | `application.properties` | P3-E | High |
| Information Disclosure | VAPID private key committed to source control | `application.properties` | P5-A | High |
| Information Disclosure | Full patient profile enumerable by incrementing DB ID | `PatientSearchPopulateRestController` | P3-A | Critical |
| Information Disclosure | Biometric photos accessible to any authenticated session | `PatientManagementRestController` | P3-C | Critical |
| Information Disclosure | National IDs in dashboard responses for all roles | `PatientDashBoardProvider` | P3-D | High |
| Information Disclosure | HAPI Swagger UI open without authentication | `hapi_application.yaml` | P5-F | Medium |
| Information Disclosure | `/OEToFhir/info` leaks DB size and processing state | `FhirTransformationController` | P4-D | Medium |
| Denial of Service | `/rest/reindex` triggers full Hibernate reindex, no rate limit | `MassIndexerRestController` | P2-C2 | High |
| Denial of Service | `/PatientToFhir?checkAll=true` exhausts threads, no cap | `FhirTransformationController` | P4-D | High |
| Denial of Service | `/fhir/optimizeStorage` triggers `$reindex`, no auth | `FhirActionController` | P4-D | High |
| Denial of Service | HAPI Tomcat shutdown port 8005 active on bridge network | `hapi_server.xml` | P5-G | Medium |
| Denial of Service | No container resource limits — host memory exhaustion | All Compose files | P5-H | Medium |
| Elevation of Privilege | `getGrantedAuthorities()` always empty — `@PreAuthorize` silently broken | `CustomUserDetailsService` | P1-A5 | Medium |
| Elevation of Privilege | REST interceptor fails open — new endpoints auto-accessible | `ModuleAuthenticationInterceptor` | P1-A6 | High |
| Elevation of Privilege | `@EnableMethodSecurity` absent — all annotations are no-ops | `SecurityConfig` | P3-I | Critical |
| Elevation of Privilege | FHIR proxy forwards any path to FHIR store without auth | `InternalFhirApi` | P4-B | Critical |
| Elevation of Privilege | HAPI servlet outside Spring Security filter chain | `FhirRestfulServer` | P4-C | Critical |
| Elevation of Privilege | AES-256 encryption key defaults to `"dev"` | `SecurityConfig` | P5-A | High |
| Elevation of Privilege | `allow_external_references: true` → SSRF via FHIR store | `hapi_application.yaml` | P5-F | High |
| Elevation of Privilege | `autoDeploy="true"` on Tomcat — drop WAR to deploy | `oe_server.xml` | P5-G | High |
| Elevation of Privilege | Dockerfile ends with `USER root` | `Dockerfile` | P5-I | Medium |
| Elevation of Privilege | External patient search `ALLOW_ALL_HOSTNAME_VERIFIER` → MitM | `ExternalPatientSearch` | P4-E | High |

**3. Vulnerability Inventory with CWE Mapping**

| Finding | CWE | CVSS (est.) | Severity |
|---------|-----|-------------|---------|
| P1-A1 Session ID in JSON | CWE-200, CWE-384 | 7.5 | High |
| P1-A2 Forged XFF in audit log | CWE-346, CWE-117 | 5.3 | Medium |
| P1-A3 Hardcoded admin password | CWE-798, CWE-1392 | 9.1 | Critical |
| P1-A4 SAML sysUserId = "1" | CWE-266, CWE-269 | 8.8 | High |
| P1-A5 Empty getGrantedAuthorities | CWE-285, CWE-863 | 5.4 | Medium |
| P1-A6 Fail-open interceptor | CWE-284, CWE-636 | 8.1 | High |
| P2-A1 Patient search PHI | CWE-862, CWE-200 | 9.1 | Critical |
| P2-A2 Audit trail no role gate | CWE-862 | 8.5 | High |
| P2-A3 User directory exposed | CWE-200 | 5.3 | Medium |
| P2-B1 Mass deletion config flag | CWE-284, CWE-749 | 9.6 | Critical |
| P2-C1 Import no admin gate | CWE-862 | 6.5 | High |
| P2-C2 Reindex DoS | CWE-400, CWE-862 | 6.5 | High |
| P2-C3 Log level manipulation | CWE-862, CWE-778 | 6.5 | High |
| P2-D1 Arbitrary FHIR resource | CWE-918, CWE-20 | 8.6 | High |
| P2-E1 Logo upload path traversal | CWE-22, CWE-434 | 6.3 | Medium |
| P2-E2 HL7 fallback sysUserId | CWE-266 | 5.0 | Medium |
| P3-A Patient detail by DB ID | CWE-639, CWE-200 | 9.1 | Critical |
| P3-C Biometric photo no auth | CWE-639, CWE-200 | 9.1 | Critical |
| P3-D National IDs in dashboard | CWE-200 | 6.5 | High |
| P3-E PHI in INFO logs | CWE-532 | 7.5 | High |
| P3-H sysUserId = "1" in 15+ files | CWE-266 | 6.3 | High |
| P3-I @EnableMethodSecurity absent | CWE-284 | 9.8 | Critical |
| P3-J CSRF disabled for /rest/** | CWE-352 | 8.0 | High |
| P3-K PropertyUtils mass assignment | CWE-915 | 5.4 | Medium |
| P4-A FhirQueryRestController SSRF | CWE-918, CWE-20 | 9.1 | Critical |
| P4-B InternalFhirApi wildcard proxy | CWE-918, CWE-601 | 9.3 | Critical |
| P4-C HAPI no auth interceptor | CWE-306 | 9.8 | Critical |
| P4-D Transform/export no auth | CWE-862, CWE-400 | 7.5 | High |
| P4-E ALLOW_ALL_HOSTNAME_VERIFIER | CWE-297 | 7.4 | High |
| P5-A Hardcoded credentials in VCS | CWE-798, CWE-321 | 9.8 | Critical |
| P5-B PostgreSQL on host port 15432 | CWE-284, CWE-1188 | 9.1 | Critical |
| P5-C proxy_ssl_verify off | CWE-295 | 5.9 | Medium |
| P5-D Zero nginx security headers | CWE-693 | 6.1 | Medium |
| P5-E EOL nginx 1.15, runs as root | CWE-1104, CWE-250 | 7.5 | High |
| P5-F HAPI CORS wildcard + ext refs | CWE-942, CWE-918 | 8.8 | High |
| P5-G Tomcat shutdown port active | CWE-284 | 6.5 | Medium |
| P5-H No container resource limits | CWE-400 | 6.5 | Medium |
| P5-I Dockerfile USER root | CWE-250 | 5.5 | Medium |
| P5-J Unsigned JARs → RCE | CWE-494, CWE-346 | 9.8 | Critical |

**4. Remediation Priority Order**

Ordered by combination of severity, exploitability, and fix effort:

- **Immediate (Week 2–3):** P3-I (`@EnableMethodSecurity`), P1-A6 (fail-closed interceptor),
  P1-A3 (default password), P5-A (credentials from VCS), P4-C (HAPI auth interceptor)
- **Short-term (Week 4–9):** All remaining P1, P2, P3 findings
- **Medium-term (Week 10–11):** All P4 FHIR findings
- **Hardening (Week 12–13):** All P5 infrastructure findings
- **Ongoing:** Documentation, test coverage, security checklist

---

## Outcome 2 — Automated Security Testing Assets

> *Including static analysis, dependency vulnerability scanning, and CI/CD-integrated
> security checks.*

### What the current proposal covers

The proposal's testing plan covers JUnit 4 unit tests, Spring context integration tests,
and Cypress E2E. It does not yet define any automated security tooling integrated into
the CI/CD pipeline.

### What is needed — and what will be built

This outcome is the largest gap. The following toolchain will be implemented and
integrated into the existing GitHub Actions workflow during Weeks 2–13 (one tool per
phase, so the pipeline grows incrementally alongside the fixes).

---

### Deliverable D2-A — SpotBugs + Find-Security-Bugs (Static Analysis)

**What it catches in this codebase specifically:**
- `XSS_REQUEST_PARAMETER_TO_SERVLET_WRITER` — unencoded output to response
- `SQL_INJECTION_JDBC` — raw SQL strings (relevant to any future DAO changes)
- `SPRING_CSRF_UNRESTRICTED_REQUEST_MAPPING` — controllers missing CSRF consideration
- `HARD_CODE_PASSWORD` — catches the remaining `setSysUserId("1")` pattern and any future hardcoded credential regressions
- `TRUST_BOUNDARY_VIOLATION` — tainted data crossing from HTTP request to business logic without validation

**Integration into Maven build:**

```xml
<!-- pom.xml — add to build/plugins -->
<plugin>
    <groupId>com.github.spotbugs</groupId>
    <artifactId>spotbugs-maven-plugin</artifactId>
    <version>4.8.3.1</version>
    <configuration>
        <plugins>
            <plugin>
                <groupId>com.h3xstream.findsecbugs</groupId>
                <artifactId>findsecbugs-plugin</artifactId>
                <version>1.13.0</version>
            </plugin>
        </plugins>
        <effort>Max</effort>
        <threshold>Low</threshold>
        <excludeFilterFile>spotbugs-exclude.xml</excludeFilterFile>
        <failOnError>true</failOnError>
    </configuration>
    <executions>
        <execution>
            <goals><goal>check</goal></goals>
        </execution>
    </executions>
</plugin>
```

A `spotbugs-exclude.xml` baseline file will be committed at project start, containing
the pre-existing findings that cannot be fixed immediately. As Phase 1–5 fixes land,
entries are removed from the baseline rather than suppressed. This makes regressions
visible: a new violation that matches an already-fixed pattern will fail the build.

**GitHub Actions integration:**

```yaml
# .github/workflows/security-static.yml
name: Static Security Analysis
on:
  pull_request:
    branches: [develop, main]
  push:
    branches: [develop]

jobs:
  spotbugs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: 'temurin'
      - name: Run SpotBugs + FindSecBugs
        run: mvn spotbugs:check -Dmaven.test.skip=true
      - name: Upload SpotBugs report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: spotbugs-report
          path: target/spotbugsXml.xml
```

---

### Deliverable D2-B — OWASP Dependency-Check (Dependency Vulnerability Scanning)

**What it catches:**
- CVEs in transitive Maven dependencies (Spring Framework, Hibernate, HAPI FHIR, Apache HttpClient, BouncyCastle)
- The nginx 1.15 base image CVEs are flagged separately by Trivy (D2-C below)
- Known vulnerable versions of `owasp-java-html-sanitizer`, `json`, and other utility libraries

**Maven integration:**

```xml
<!-- pom.xml -->
<plugin>
    <groupId>org.owasp</groupId>
    <artifactId>dependency-check-maven</artifactId>
    <version>9.2.0</version>
    <configuration>
        <failBuildOnCVSS>7</failBuildOnCVSS>
        <suppressionFile>dependency-check-suppressions.xml</suppressionFile>
        <formats>
            <format>HTML</format>
            <format>JSON</format>
        </formats>
    </configuration>
    <executions>
        <execution>
            <goals><goal>check</goal></goals>
        </execution>
    </executions>
</plugin>
```

The CVSS threshold of 7 means any newly introduced dependency with a High or Critical
CVE fails the build immediately. A `dependency-check-suppressions.xml` file documents
accepted exceptions with a justification and a review date.

**GitHub Actions integration:**

```yaml
# Added as a job in security-static.yml
  dependency-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: 'temurin'
      - name: OWASP Dependency Check
        run: mvn dependency-check:check -Dmaven.test.skip=true
      - name: Upload dependency report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: dependency-check-report
          path: target/dependency-check-report.html
```

---

### Deliverable D2-C — Trivy (Container Image Vulnerability Scanning)

**What it catches:**
- OS-level CVEs in the nginx 1.15 base image (CVE-2019-9511, CVE-2019-9513,
  CVE-2019-9516, CVE-2021-23017 — all addressed by the P5-E base image upgrade)
- OS-level CVEs in the Tomcat/JDK base image used by `Dockerfile`
- Secrets accidentally committed to the image layer (VAPID key, `kspass`, etc.) —
  Trivy's secret scanning catches these even if the file is in an intermediate layer

**GitHub Actions integration:**

```yaml
# .github/workflows/security-container.yml
name: Container Security Scan
on:
  pull_request:
    paths:
      - 'Dockerfile'
      - 'nginx-proxy/Dockerfile'
      - 'docker-compose.yml'
      - '.github/workflows/security-container.yml'

jobs:
  trivy-app:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build application image
        run: docker build -t openelis-app:scan .
      - name: Trivy scan — app image
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: 'openelis-app:scan'
          format: 'sarif'
          output: 'trivy-app.sarif'
          severity: 'HIGH,CRITICAL'
          exit-code: '1'
      - name: Upload Trivy SARIF
        uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: 'trivy-app.sarif'

  trivy-nginx:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build nginx image
        run: docker build -t openelis-nginx:scan ./nginx-proxy
      - name: Trivy scan — nginx image
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: 'openelis-nginx:scan'
          format: 'sarif'
          output: 'trivy-nginx.sarif'
          severity: 'HIGH,CRITICAL'
          exit-code: '1'
      - name: Upload Trivy SARIF
        uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: 'trivy-nginx.sarif'
```

Trivy SARIF output is uploaded to GitHub's Security tab, making CVEs visible directly
in the repository's security dashboard without needing to read CI logs.

---

### Deliverable D2-D — Semgrep (Custom Rules for OpenELIS-Specific Patterns)

Generic static analysis tools do not know about OpenELIS internals. Semgrep rules will
be written to catch patterns that are specific to this codebase and that caused the
findings in this audit — so regressions are caught automatically before they reach
review.

**Rule set: `semgrep/openelis-security.yml`**

```yaml
rules:
  - id: openelis-hardcoded-sysUserId
    patterns:
      - pattern: $X.setSysUserId("1")
    message: >
      Hardcoded sysUserId "1" assigns admin audit context to this operation.
      Resolve the acting user from the session (UserSessionData) instead.
      See finding P3-H in the security audit.
    languages: [java]
    severity: ERROR

  - id: openelis-rest-interceptor-failopen
    patterns:
      - pattern: |
          if (isRestFullPath()) {
              return true;
          }
    message: >
      This pattern causes the ModuleAuthenticationInterceptor to fail open
      for unregistered REST paths. Register the path in SystemModuleUrl or
      add it to AUTHENTICATED_OPEN_REST_PATHS. See finding P1-A6.
    languages: [java]
    severity: ERROR

  - id: openelis-session-id-in-response
    patterns:
      - pattern: $SESSION.setSessionId($REQUEST.getSession().getId())
    message: >
      Session ID must not be serialised into the API response body.
      The HttpOnly cookie flag is negated by this pattern. See finding P1-A1.
    languages: [java]
    severity: ERROR

  - id: openelis-xforwardedfor-raw-trust
    patterns:
      - pattern: $REQ.getHeader("X-Forwarded-For")
    message: >
      Raw X-Forwarded-For header is attacker-controllable. Use
      request.getRemoteAddr() after configuring RemoteIpValve with a
      trusted proxy range. See finding P1-A2.
    languages: [java]
    severity: WARNING

  - id: openelis-fhir-resourcetype-unvalidated
    patterns:
      - pattern: |
          @PathVariable("resourceType") String $RT
          ...
          searchUrl.append($RT)
    message: >
      FHIR resourceType path variable is appended to a URL without allowlist
      validation. Validate against ALLOWED_FHIR_TYPES before use. See P2-D1, P4-A.
    languages: [java]
    severity: ERROR

  - id: openelis-propertyutils-copy
    patterns:
      - pattern: PropertyUtils.copyProperties(...)
    message: >
      PropertyUtils.copyProperties performs bulk reflection-based copy of all
      same-named fields. Replace with an explicit field-by-field mapping to
      prevent mass assignment. See finding P3-K.
    languages: [java]
    severity: WARNING

  - id: openelis-allow-all-hostname-verifier
    patterns:
      - pattern: SSLSocketFactory.ALLOW_ALL_HOSTNAME_VERIFIER
    message: >
      ALLOW_ALL_HOSTNAME_VERIFIER disables TLS hostname verification entirely.
      Use STRICT_HOSTNAME_VERIFIER. See finding P4-E.
    languages: [java]
    severity: ERROR
```

**GitHub Actions integration:**

```yaml
# Added as a job in security-static.yml
  semgrep:
    runs-on: ubuntu-latest
    container:
      image: semgrep/semgrep
    steps:
      - uses: actions/checkout@v4
      - name: Run OpenELIS security rules
        run: semgrep --config semgrep/openelis-security.yml
                     --error
                     --json
                     --output semgrep-results.json
                     src/
      - name: Upload Semgrep results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: semgrep-results
          path: semgrep-results.json
```

---

### Deliverable D2-E — Security Gate Summary in Pull Request Comments

A composite GitHub Actions workflow step will post a summary comment on every PR
listing the status of all four security checks (SpotBugs, Dependency-Check, Trivy,
Semgrep) in a single table, so reviewers do not need to open four separate job logs.

```yaml
# At the end of the security-static.yml workflow
  security-summary:
    needs: [spotbugs, dependency-check, semgrep]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - name: Post security check summary
        uses: actions/github-script@v7
        with:
          script: |
            const jobs = context.payload.workflow_run?.conclusion || 'unknown';
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: `## Security Check Results\n` +
                    `| Check | Status |\n|-------|--------|\n` +
                    `| SpotBugs + FindSecBugs | ${{ needs.spotbugs.result }} |\n` +
                    `| OWASP Dependency-Check | ${{ needs.dependency-check.result }} |\n` +
                    `| Semgrep (OpenELIS rules) | ${{ needs.semgrep.result }} |\n` +
                    `| Trivy (on Dockerfile changes) | runs on Dockerfile PRs |\n`
            });
```

---

### Deliverable D2-F — npm audit for Frontend Dependencies

The React frontend has its own dependency tree. A weekly scheduled workflow will run
`npm audit --audit-level=high` and open a GitHub issue automatically if new High or
Critical CVEs are introduced in the `frontend/` dependency tree.

```yaml
# .github/workflows/frontend-security.yml
name: Frontend Dependency Audit
on:
  schedule:
    - cron: '0 6 * * 1'   # Every Monday at 06:00 UTC
  pull_request:
    paths: ['frontend/package.json', 'frontend/package-lock.json']

jobs:
  npm-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '18'
      - run: cd frontend && npm ci
      - run: cd frontend && npm audit --audit-level=high
```

---

## Outcome 3 — Targeted Security Fixes

> *Addressing high-risk vulnerabilities through patches or pull requests.*

### What the proposal already covers

Every one of the 36 findings in Phases 1–5 has a patch. The patches are described at
code-diff level — specific method names, specific line numbers, specific code to add or
remove. For the most critical fixes, actual code is provided inline.

### Planned PR structure

One PR per phase, labelled `security/phase-N`. Each PR:
- References the finding IDs it addresses in the description
- Includes JUnit 4 tests that were failing before the fix and pass after
- Includes a Liquibase changeset for any database change
- Passes `mvn spotless:apply` formatting check
- Passes all Semgrep rules from D2-D
- Has been validated with `./scripts/run-e2e-like-ci.sh` before submission

The PR template addition (see Outcome 4) will include a security checklist so that
future contributors follow the same standard.

### Priority ordering for patches

The three patches that must land first because everything else depends on them:

1. **P3-I** — Add `@EnableMethodSecurity(prePostEnabled = true)` to `SecurityConfig`.
   Without this, every `@PreAuthorize` annotation added in every other phase is a no-op.
   This is a one-line change but it is the most foundational fix in the entire project.

2. **P1-A6** — Change `ModuleAuthenticationInterceptor` from fail-open to fail-closed.
   Without this, role annotations on controllers are bypassed by the interceptor
   returning `true` before they are evaluated.

3. **P5-A** — Remove all hardcoded credentials from Compose files. Without this,
   every deployment of the "hardened" stack still runs with public default credentials,
   making all other fixes irrelevant in practice.

---

## Outcome 4 — Security Documentation

> *Outlining secure deployment guidelines and coding best practices for OpenELIS
> contributors.*

### What the proposal currently mentions

The Week 14 entry says: "Add a security checklist to `AGENTS.md` and
`PULL_REQUEST_TIPS.md`." That is the extent of it. This outcome requires substantially
more.

### Deliverable D4-A — Secure Deployment Guide

**File:** `docs/security/secure-deployment.md`

Sections:
1. **Required environment variables** — complete table of every `:?`-enforced variable
   introduced in Phase 5, with description, format requirements, and how to generate
   a suitable value (e.g., `openssl rand -base64 32` for the encryption key,
   `web-push generate-vapid-keys` for VAPID).

2. **What must never appear in source control** — explicit list: admin password,
   database passwords, keystore passwords, encryption key, VAPID private key,
   datasource.password file contents.

3. **Docker Secrets usage** — step-by-step instructions for creating Docker secrets
   for the three most sensitive values (DB password, encryption key, VAPID private key)
   so they are never passed as environment variables.

4. **Network isolation** — which ports should never be exposed on the host in production
   (PostgreSQL 15432, Tomcat 8443, HAPI 8080), and why Docker internal DNS is sufficient.

5. **TLS checklist** — how to configure `proxy_ssl_trusted_certificate` in nginx,
   how to verify the internal CA cert is mounted correctly, and how to confirm
   `proxy_ssl_verify on` is active (`curl -v` expected output).

6. **Post-install security validation** — a shell script `scripts/verify-deployment.sh`
   that checks:
   - PostgreSQL port 15432 is not reachable from outside the Docker network
   - `DEFAULT_PW` is not set to any known-public value
   - nginx returns `Strict-Transport-Security` in response headers
   - `proxy_ssl_verify` is `on` in the active nginx config
   - Hibernate SQL logging is not at TRACE or DEBUG level
   - The HAPI Swagger UI returns 404 or 403 (not 200)

---

### Deliverable D4-B — Contributor Security Coding Standards

**File:** `docs/security/coding-standards.md`

Sections:

**1. Authorization — the three-layer rule**

Every new REST endpoint must have all three of these before a PR is opened:

- A `SystemModuleUrl` Liquibase changeset registering it with the correct module
- A `@PreAuthorize` annotation (enforced now that `@EnableMethodSecurity` is active)
- A service-layer guard that does not trust the controller's role check alone

If a path is intentionally open to all authenticated users, it must be explicitly added
to `AUTHENTICATED_OPEN_REST_PATHS` in `ModuleAuthenticationInterceptor` with a comment
explaining why.

**2. PHI handling rules**

- Never log PHI at any level. Use event counts and reference IDs in log messages.
- Never include patient names, national IDs, DOBs, or diagnoses in log strings.
- `LogEvent.logInfo()` calls in patient-touching code paths must be reviewed in every PR.
- No `System.out.println()` in production code paths.

**3. Secrets hygiene**

- No credential, key, or password in any source-controlled file under any circumstances.
- Every new secret reference must use `${ENV_VAR:?descriptive error message}` syntax.
- Secrets used in tests must use random values generated at test time, not hardcoded strings.
- The VAPID key, AES encryption key, and all keystore passwords rotate on a defined schedule (annually minimum, immediately on any suspected exposure).

**4. FHIR endpoint rules**

- Every new `@GetMapping` or `@PostMapping` that accepts a `{resourceType}` path variable
  must validate it against `ALLOWED_FHIR_TYPES` as the first statement in the method.
- Every new `IResourceProvider` bean is automatically registered by HAPI — confirm the
  `FhirAuthorizationInterceptor` covers it before adding the bean.
- Never forward raw `request.getParameterMap()` to any downstream service.

**5. sysUserId rules**

- Never hardcode `setSysUserId("1")` or any other literal user ID.
- Resolve the acting user from `UserSessionData` in the HTTP session for request-scoped operations.
- For scheduled jobs with no HTTP context, use the designated `system_scheduler` service account (sysUserId 2).

**6. Test requirements**

- JUnit 4 only (`org.junit.Test`). No JUnit 5. No `@SpringBootTest`.
- Every security-relevant fix must include a test that was failing before the fix.
- Mockito for unit tests; `BaseWebContextSensitiveTest` for Spring context tests.
- E2E validation via `./scripts/run-e2e-like-ci.sh` before any PR touching auth,
  session, or FHIR flows.

---

### Deliverable D4-C — PR Template Security Checklist Addition

**File:** `.github/PULL_REQUEST_TEMPLATE.md` — new section appended

```markdown
## Security Checklist

If this PR touches any of the following areas, check the corresponding box and
describe how it was addressed in the PR description.

- [ ] **New REST endpoint** — `SystemModuleUrl` Liquibase changeset added,
      `@PreAuthorize` annotation present, service-layer guard present.
- [ ] **PHI-touching code** — no patient names, national IDs, or clinical values
      in any `LogEvent` call. Verified with Semgrep (`semgrep/openelis-security.yml`).
- [ ] **New secret or credential** — uses `${ENV_VAR:?}` syntax, not hardcoded.
      Added to `docs/security/secure-deployment.md` variable table.
- [ ] **FHIR path variable** — validated against `ALLOWED_FHIR_TYPES` allowlist.
- [ ] **sysUserId usage** — resolved from session, not hardcoded to `"1"`.
- [ ] **File upload** — extension check uses `.endsWith()`, content verified before
      write, path sanitized against traversal.
- [ ] **SpotBugs + FindSecBugs** — `mvn spotbugs:check` passes with no new violations.
- [ ] **OWASP Dependency-Check** — no new CVEs above CVSS 7 introduced.
- [ ] **Semgrep** — all OpenELIS security rules pass.
- [ ] **E2E** — `./scripts/run-e2e-like-ci.sh` passed for auth/session/FHIR changes.
```

---

### Deliverable D4-D — AGENTS.md Security Section

**File:** `AGENTS.md` — new `## Security` section added

Content:

```markdown
## Security

### Before opening a PR

Run the full security check suite:
```
mvn spotbugs:check -Dmaven.test.skip=true
mvn dependency-check:check -Dmaven.test.skip=true
semgrep --config semgrep/openelis-security.yml src/
```

For PRs touching auth, session, or FHIR: run E2E validation:
```
./scripts/run-e2e-like-ci.sh
```

### Key invariants that must never be broken

1. `ModuleAuthenticationInterceptor.hasPermissionForUrl()` must never return `true`
   for an unregistered REST path. The fail-closed behaviour added in Phase 1 must
   be preserved. Any change to this method requires a dedicated reviewer sign-off.

2. `SecurityConfig` must keep `@EnableMethodSecurity(prePostEnabled = true)`.
   Removing it silently disables every `@PreAuthorize` annotation in the codebase.

3. No credential, password, or private key may appear in any source-controlled file.
   Use `${ENV_VAR:?}` and Docker secrets. The CI workflow will fail if Trivy or
   Semgrep detects a hardcoded secret.

4. `setSysUserId("1")` is banned. The Semgrep rule `openelis-hardcoded-sysUserId`
   will flag it as a build error.

### Reporting a security vulnerability

Do not open a public GitHub issue. Email the maintainers directly at
[security contact from project docs] with the subject line
`[OpenELIS Security] <brief description>`. Include the affected file, line number,
and a description of the exploit path. You will receive a response within 72 hours.
```

---

## Outcome 5 — Improved Security Awareness

> *Within the OpenELIS community through actionable findings and recommendations.*

### What the proposal currently covers

The risk registers at the end of each phase provide structured severity ratings and
finding IDs. The Week 14 buffer mentions a final report. There is no explicit community-
facing deliverable — no public findings summary, no structured way findings are
communicated beyond PR descriptions, and no mechanism for the broader community of
deployers (not just developers) to understand the risks.

### Deliverable D5-A — Public Security Findings Summary

**File:** `docs/security/findings-summary-2025.md`

A non-technical-friendly summary of what was found, what was fixed, and what the impact
would have been if left unfixed. Written for an audience that includes lab IT staff,
system administrators, and project managers — not just developers.

Structure:

```
## What this audit covered
## The five most important findings (non-technical descriptions)
## What has been fixed and when
## What deployers should do right now (actionable checklist)
## How to verify your deployment is no longer vulnerable
```

The "what deployers should do right now" section will be specific and concrete:

| Action | Why | How |
|--------|-----|-----|
| Change your admin password immediately if it has not been changed since deployment | `adminADMIN!` is public and in the git history | Run the password reset flow as described in the admin guide |
| Rotate your database password | `clinlims` (username = password) is a known-default attack target | Update `OE_DB_PASSWORD` and restart the stack |
| Rotate your VAPID key pair | The private key committed to the repository is now public | Run `scripts/generate-vapid-keys.sh` and update your environment |
| Rotate your AES encryption key | `kspass` or `dev` are known-weak and were used to encrypt DB credentials | Run the key rotation script and re-encrypt affected records |
| Verify PostgreSQL is not exposed | Port 15432 should not be reachable from outside your server | `nc -z <server-ip> 15432` should time out from any external host |

---

### Deliverable D5-B — Community Presentation / Write-up

A short write-up (800–1000 words) suitable for posting to the OpenELIS community
mailing list or discussion forum at the end of the project. It will:

- Describe the five root architectural patterns identified (without disclosing
  unpatched exploit details)
- Explain the three-layer authorization rule that every new endpoint now follows
- Walk through one finding end-to-end (session ID in JSON response) as a concrete
  example of how the audit worked and what was changed
- Invite community members to review the new security coding standards and the PR
  template checklist

The goal is to build shared understanding of why these patterns are dangerous in a
healthcare context — so the next developer who considers adding a convenience default
or skipping a module registration understands the consequences.

---

### Deliverable D5-C — Security Regression Prevention

The most durable form of security awareness is making regressions impossible rather
than relying on individual developers remembering rules. The Semgrep rules in D2-D
serve this purpose: `openelis-hardcoded-sysUserId`, `openelis-rest-interceptor-failopen`,
`openelis-session-id-in-response`, `openelis-xforwardedfor-raw-trust`,
`openelis-fhir-resourcetype-unvalidated`, `openelis-propertyutils-copy`, and
`openelis-allow-all-hostname-verifier` are all patterns that caused real findings in
this audit. Every one of them will fail the CI build if reintroduced.

This is the highest-leverage form of community education: the codebase itself teaches
the rule by rejecting violations automatically.

---

## Outcome Coverage Summary

| Outcome | Status in Proposal | Gap | Deliverable |
|---------|-------------------|-----|-------------|
| 1. Comprehensive Audit Report | ✅ Fully covered — 36 findings, severity, patches, risk registers | STRIDE table was only in phase1_detailed.md | D1 — unified final audit report with full STRIDE model |
| 2. Automated Security Testing | ❌ Not in proposal at all | Entire outcome missing | D2-A (SpotBugs), D2-B (OWASP DC), D2-C (Trivy), D2-D (Semgrep), D2-E (PR summary), D2-F (npm audit) |
| 3. Targeted Security Fixes | ✅ Fully covered — every finding has a patch | Priority ordering of the three foundational fixes could be clearer | Clarified in this document; PR structure defined |
| 4. Security Documentation | ⚠️ One line in Week 14 only | Deployment guide, coding standards, PR checklist, AGENTS.md section all missing | D4-A (deployment guide), D4-B (coding standards), D4-C (PR template), D4-D (AGENTS.md) |
| 5. Security Awareness | ⚠️ Risk registers exist; no community-facing deliverable | Public findings summary, community write-up, regression prevention all missing | D5-A (findings summary), D5-B (community write-up), D5-C (Semgrep as regression prevention) |

---

*This document is a companion to `gsoc_proposal.md` and the five phase audit files.*
*Together they constitute the complete GSoC 2025 project proposal for OpenELIS Global 2 security hardening.*
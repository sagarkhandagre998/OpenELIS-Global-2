OpenELIS Global 2 — Comprehensive Deep-Dive Overview

Before we begin the security audit, it's essential to fully understand what you're auditing. OpenELIS is **far more complex than a typical web application** — it sits at the intersection of clinical workflows, healthcare standards, real-time instrument integration, and multi-country deployment. Let's break it all down.

---

## 1. What Is OpenELIS?

**OpenELIS Global 2** (OEL2) is an open-source **Laboratory Information Management System (LIMS)** built to support public health laboratories. It is used at scale across Africa, Southeast Asia, and Haiti — from small clinic labs to national reference laboratories.

Its core responsibilities are:
- **Receiving lab orders** (electronic or manual)
- **Tracking specimens** through the lab lifecycle
- **Connecting to clinical analyzers** (instruments) and importing results
- **Validating and releasing lab results**
- **Reporting results** to clinicians, patients, or external health systems (via FHIR, print, SMS)
- **Supporting ISO 15189 and SLIPTA accreditation** compliance

It is a **mission-critical healthcare system** — incorrect results or data breaches directly impact patient safety.

---

## 2. Technology Stack

### Backend

| Layer | Technology |
|---|---|
| Language | Java 21 |
| Web Framework | Spring MVC 6.2.x (traditional, NOT Spring Boot) |
| Security | Spring Security 6.2.x |
| ORM | Hibernate 5.6.x |
| Database | PostgreSQL 42.7.x (JDBC) |
| FHIR | HAPI FHIR 7.0.2 (R4) |
| Migrations | Liquibase (versioned under `src/main/resources/liquibase/`) |
| Build | Maven (WAR packaging, deployed to Tomcat) |
| Serialization | Jackson 2.18.x |
| Logging | Log4j2 + SLF4J |
| Password Hashing | BCrypt (jBCrypt + Spring's `BCryptPasswordEncoder`) |
| Encryption | Spring Security Crypto (AES-256) |
| Job Scheduling | Quartz |
| File Parsing | Apache POI, Castor XML |
| HTTP Client | Apache HttpClient (inside HAPI FHIR) |
| Push Notifications | VAPID / Web Push |

### Frontend

| Layer | Technology |
|---|---|
| Language | JavaScript (React 17) |
| UI Framework | IBM Carbon Design System (`@carbon/react`) |
| Routing | React Router |
| State | React Context API |
| i18n | React Intl (with `en`, `fr`, and other locales) |
| Testing | Jest + React Testing Library + Cypress (E2E) |
| Formatting | Prettier |

### Infrastructure / DevOps

| Component | Technology |
|---|---|
| Containerization | Docker Compose (multi-service) |
| Reverse Proxy | Nginx (custom config) |
| TLS Termination | Nginx + self-signed keystore/truststore via `itechuw/certgen` |
| Secrets Management | Docker secrets (`common.properties` file mounted as a secret) |
| CI | GitHub Actions (build, test, publish, E2E) |

---

## 3. System Architecture

OpenELIS is a **multi-container system** with the following distinct services:

```/dev/null/architecture.txt#L1-15
┌────────────────────────────────────────────────────────────┐
│                     NGINX Reverse Proxy                    │
│              (ports 80/443, TLS termination)               │
└──────────┬─────────────────────┬──────────────────────────┘
           │                     │
   ┌───────▼──────┐     ┌────────▼────────┐
   │   Frontend   │     │  OE WebApp       │
   │ React (SPA)  │     │ Spring MVC/War   │
   │ Nginx served │     │ Tomcat 8080/8443 │
   └──────────────┘     └────────┬─────────┘
                                 │
                    ┌────────────▼────────┐
                    │ External FHIR API   │
                    │ HAPI FHIR R4 Server │
                    │ Tomcat 8081/8444    │
                    └────────────┬────────┘
                                 │
                    ┌────────────▼────────┐
                    │   PostgreSQL DB      │
                    │ (clinlims schema)    │
                    │    port 15432        │
                    └─────────────────────┘
```

### Backend Layer Architecture (Strict 5-Layer)

```/dev/null/layers.txt#L1-8
ValueHolder (Entity)
    ↓
DAO / DAOImpl (Hibernate HQL queries)
    ↓
Service / ServiceImpl (@Transactional — business logic lives here)
    ↓
Controller (Spring MVC — request/response mapping only)
    ↓
Form / DTO (data transfer between layers)
```

This is strictly enforced by the project's constitution. Controllers must not call DAOs directly, and `@Transactional` belongs on services, not controllers.

---

## 4. Key Functional Modules

The `src/main/java/org/openelisglobal/` package tree (80+ modules) represents the entire LIMS domain:

### Clinical Workflow Modules
| Module | Purpose |
|---|---|
| `sample` | Sample receipt, accession number management |
| `sampleitem` | Individual test items within a sample |
| `analysis` | Test analysis lifecycle (assigned → completed → released) |
| `result` / `resultvalidation` | Result entry, QA validation, supervisor approval |
| `patient` | Patient demographics, identity, PHI storage |
| `referral` | Referring samples to external labs |
| `pathology`, `cytology`, `immunohistochemistry` | Specialized lab programs |

### Instrument / Analyzer Integration
| Module | Purpose |
|---|---|
| `analyzer` | Analyzer configuration registry |
| `analyzerimport` | File-based analyzer result import (CSV, HL7, proprietary) |
| `analyzerresults` | Staging area for imported results pending review |

### Interoperability Modules
| Module | Purpose |
|---|---|
| `fhir` | HAPI FHIR R4 server, resource providers, transformations |
| `dataexchange` | FHIR-based order/result exchange with external systems |
| `datasubmission` | Aggregate reporting (malaria surveillance, etc.) |
| `externalconnections` | Configurable HTTP connections to external systems |
| `ocl` | OpenConceptLab integration for test dictionary import |
| `odoo` | Odoo ERP integration for billing/inventory sync |

### Administration Modules
| Module | Purpose |
|---|---|
| `login` / `security` | Authentication, session management, RBAC |
| `systemuser` / `userrole` | User management, role assignments |
| `audittrail` | Historical change tracking (who changed what, when) |
| `siteinformation` | System-wide configuration key-value store |
| `configuration` | Programmatic config access |
| `liquibase` | Schema migration coordination |

### Notification Modules
| Module | Purpose |
|---|---|
| `notification` / `notifications` | Push notification framework (VAPID/Web Push) |
| `notificationcenter` | In-app notification management |

---

## 5. Authentication & Authorization Architecture

This is the most security-critical part of the system.

### Supported Authentication Methods (Multi-Chain Spring Security)

Spring Security is configured with **multiple ordered `SecurityFilterChain` beans**:

| Order | Chain | Mechanism |
|---|---|---|
| 1 | `openSecurityFilterChain` | Completely open (no auth required) for health checks, static assets, password change |
| 2 | `httpBasicServletFilterChain` | HTTP Basic Auth for API/REST clients (conditional on property) |
| 3 | `samlSecurityFilterChain` | SAML 2.0 SSO (e.g., Keycloak) |
| 4 | `openidSecurityFilterChain` | OAuth2/OIDC SSO |
| 5 | `clientCertificateSecurityFilterChain` | mTLS client certificate auth |
| 6 | `defaultSecurityConfigurationFilterChain` | Form-based login (default) |

### Authorization Model (RBAC)
- The project uses a **custom Role-Based Access Control** (RBAC) model
- Roles are stored in the `clinlims` database under the `userrole` tables
- The `ModuleAuthenticationInterceptor` enforces page-level access control by checking if the current user's roles are authorized for the requested module
- `@PreAuthorize("hasRole('ADMIN')")` is used on a **small handful of REST endpoints** (notably `SiteBrandingRestController`)
- Most authorization is done **imperatively** through the `UserModuleService` and action constants — not declaratively via annotations

### Password Security
- Passwords are hashed with **BCrypt** (work factor 12) via `PasswordUtil` and Spring's `BCryptPasswordEncoder`
- The `LoginUserServiceImpl` validates that passwords are BCrypt-hashed before storing and logs a warning if not
- Password expiry is enforced (configurable in months)
- Account lockout after too many failed attempts is referenced in error messages

---

## 6. Data Flow: A Full Sample Lifecycle

```/dev/null/flow.txt#L1-12
1. Order Reception
   └─ FHIR Task/ServiceRequest received by FhirRestfulServer
      └─ dataexchange/fhir transforms → saves to DB

2. Sample Entry
   └─ Clinician enters sample via React UI → /rest/sample → SampleController
      └─ SampleService → SampleDAO → PostgreSQL

3. Analyzer Import
   └─ Analyzer file dropped in /data/analyzer-imports/
      └─ FileImportService polls directory → parses → AnalyzerResultsService
         └─ Results staged in analyzerresults table

4. Result Validation
   └─ Lab scientist reviews → resultvalidation workflow
      └─ ResultService.saveResults() → audittrail.History saved

5. Result Reporting
   └─ FHIR DiagnosticReport generated → fhir.openelis.org pushed
      └─ Optionally SMS sent via JSMPP (ozeki module)
```

---

## 7. Database & Schema Management

- Database: **PostgreSQL**, schema: `clinlims`
- The connection is managed via **JNDI** (`jdbc/LimsDS`) configured in Tomcat's `context.xml`, not directly in Spring — this is why `DatabaseConfig.java` uses `JndiDataSourceLookup`
- Credentials are passed as Docker environment variables / `CATALINA_OPTS` JVM flags
- Schema evolution is handled **exclusively via Liquibase** versioned under `src/main/resources/liquibase/`, spanning versions `2.0.x.x` through `3.4.x.x`
- The DB port `15432` is **exposed to the host** in the default compose file

### ORM Pattern
- All queries use **Hibernate HQL** with parameterized queries (`setParameter`, `setParameterList`) — this is the standard and correct approach
- One instance of `createNativeQuery` was spotted in `AlertDAOImpl` — a potential area to watch
- No raw JDBC `Statement` concatenation was found in a quick scan

---

## 8. Frontend Architecture

The React SPA communicates with the backend via:
- `fetch()` calls to `config.serverBaseUrl + "/rest/..."` REST endpoints
- `credentials: "include"` on all requests to carry the session cookie
- Form-login via a POST to `/ValidateLogin?apiCall=true` using `application/x-www-form-urlencoded`

### Session Management
- Authentication state is tracked via the `UserSessionDetailsContext` (React Context)
- The frontend polls `/session` every 3 seconds to check login status
- On logout, the backend invalidates the HTTP session at `/Logout`

### CSRF Handling
The Spring Security config specifically **exempts** the following from CSRF protection:
```/dev/null/csrf-exceptions.txt#L1-4
/ValidateLogin      ← login form (legitimate)
/rest/**            ← all REST endpoints
/api/OpenELIS-Global/rest/**  ← legacy API prefix
```

---

## 9. FHIR/Interoperability Layer

- **HAPI FHIR R4** is embedded both inside the main webapp and as a **separate microservice** (`fhir.openelis.org`)
- The main app's `FhirRestfulServer` discovers all Spring `IResourceProvider` beans and registers them
- FHIR resources include: `Patient`, `Task`, `ServiceRequest`, `DiagnosticReport`, `Observation`, `Specimen`, `Practitioner`, `Encounter`
- External FHIR store, subscriber, and facility list (GOFR) connections are configurable via `application.properties`
- SSL between internal services uses a shared keystore/truststore volume generated by `itechuw/certgen`

---

## 10. Plugin System

```/dev/null/plugin-note.txt#L1-3
volume/plugins/  → mounted at /var/lib/openelis-global/plugins
```
OpenELIS supports a **dynamic plugin system** where JARs can be dropped into a volume-mounted directory and loaded at runtime. This is used for country-specific lab programs (pathology, cytology workflows). The `plugin` Java package manages the loading lifecycle.

---

## 11. File Import / Analyzer Results System

- Analyzer result files (CSV, HL7, proprietary formats) are polled from `/data/analyzer-imports/`
- The polling interval is configurable: `file.import.poll.interval=60000` (60s)
- The **path traversal boundary** is explicitly set to `/data/analyzer-imports/` as a `base.directory`
- Multiple analyzer reader implementations exist in `analyzerimport/analyzerreaders/`

---

## 12. Secrets & Configuration Management

| Secret | Current Location |
|---|---|
| DB password | Docker env var / `CATALINA_OPTS` |
| SSL keystore passwords | Docker env vars |
| AES-256 encryption key (`encryption.general.password`) | Docker secrets (`common.properties`) |
| VAPID push notification keys | Hardcoded in `application.properties` |
| Default admin password | `adminPassword.txt` (BCrypt hash) + `DEFAULT_PW` env var |
| FHIR store credentials | Commented-out `application.properties` entries |
| SSL passwords in dev | `testtest` hardcoded in `application.properties` |

The production deployment model uses **Docker secrets** for `common.properties`, which is the correct approach. Development defaults contain obvious placeholder passwords.

---

## 13. Logging & Audit Trail

- **Application Logs**: Log4j2, rolling file at `/var/lib/openelis-global/logs/openELIS.log` (100KB files, max 100)
- **Audit Trail**: The `audittrail` module stores a `History` entity for every data-changing operation — this is critical for ISO 15189 / SLIPTA compliance
- **DEBUG SQL logging**: `application.properties` has Hibernate SQL debug logging **enabled by default** (`logging.level.org.hibernate.SQL=DEBUG`, `BasicBinder=TRACE`) — this can leak PHI into logs

---

## 14. Key Identified Risk Areas (Preview for Audit)

This is a **high-level preview** — not a full audit, just a map of where we'll dig deeper:

| # | Area | Concern |
|---|---|---|
| 1 | **CORS** | `CORSFilter` reflects `Origin` header with no whitelist — wildcard-style reflection |
| 2 | **CSRF** | All `/rest/**` endpoints explicitly exempt from CSRF protection |
| 3 | **XSS Filter** | `SecurityFilter` only checks `<script>` tags — trivially bypassed |
| 4 | **VAPID Keys** | Private push notification key hardcoded in `application.properties` |
| 5 | **SQL Logging** | Hibernate SQL + bind params logged at DEBUG/TRACE — PHI exposure risk |
| 6 | **Content-Security-Policy** | `unsafe-inline` and `unsafe-eval` allowed in CSP |
| 7 | **DB Port Exposure** | Port `15432` exposed directly to host in `docker-compose.yml` |
| 8 | **FHIR Server (no auth)** | `FhirRestfulServer` has no authentication/authorization layer |
| 9 | **RBAC gaps** | `@PreAuthorize` is used on only a few endpoints; most rely on interceptor-based module auth |
| 10 | **File Import** | Directory polling with configurable paths — path traversal boundary worth deep inspection |
| 11 | **Plugin System** | Dynamic JAR loading from volume — arbitrary code execution risk |
| 12 | **Health Endpoint** | `/health/**` is fully open (no auth) and returns system status |
| 13 | **Default Credentials** | `DEFAULT_PW=adminADMIN!` in Docker compose — default credential risk |
| 14 | **HTTP Basic over REST** | HTTP Basic auth enabled by default for REST — credentials in every request |
| 15 | **Native Query** | One `createNativeQuery` in `AlertDAOImpl` — needs injection audit |

---

## Summary

OpenELIS Global 2 is a **mature, well-structured healthcare LIMS** with a clear layered architecture, proper ORM usage (parameterized HQL), BCrypt password hashing, and support for enterprise authentication flows (SAML, OAuth2, mTLS). It stores PHI, processes clinical results, integrates with national health infrastructure, and must meet ISO 15189 / SLIPTA compliance.

The **security surface is broad** because of its multi-protocol nature (HTTP, FHIR, SMPP, file-based analyzer import, plugin loading) and its PHI data sensitivity. Several architectural decisions (CSRF exemptions on REST, open CORS, weak XSS filter, PHI-in-logs) are areas we'll prioritize in the audit.

---

**Whenever you're ready**, we can proceed with the formal security audit — I suggest we start with the highest-impact areas first: **authentication/session security → CORS/CSRF → PHI data exposure → FHIR endpoint security → infrastructure hardening**. Just say the word.
🏗️ Application Layer Architecture — Deep Dive Analysis

Here is a detailed breakdown of **every component** shown in the architecture diagram, mapped directly to the actual code in this project.

---

## 1. 🟩 Nginx — SSL Termination & Reverse Proxy

**What it is:** The front door of the entire system. All external HTTP/HTTPS traffic hits Nginx first.

**Where it lives in the project:**
- `nginx-proxy/Dockerfile` — builds the Nginx container (Alpine-based)
- `volume/nginx/nginx.conf` — the actual routing configuration
- `docker-compose.yml` → `proxy` service

**What it does in this project:**

```OpenELIS-Global-2/volume/nginx/nginx.conf#L1-20
worker_processes 1;
events { worker_connections 1024; }
http {
    server {
        listen 80;
        server_name _;
        return 301 https://$host$request_uri;   // Force HTTPS
    }
```

- **SSL Termination:** All port 80 traffic is hard-redirected to HTTPS (443). TLS 1.2/1.3 enforced with self-signed or Let's Encrypt certs.
- **Reverse Proxy routing:** It routes traffic to 3 different backend services:
  - `/` → `frontend.openelis.org:3000` (React frontend)
  - `/api/` → `oe.openelis.org:8443` (Spring app REST API)
  - `/rest/` → `oe.openelis.org:8443` (Spring app legacy REST)
- **Real IP forwarding:** Passes `X-Real-IP`, `X-Forwarded-For`, and `X-Forwarded-Proto` headers to upstream services.

---

## 2. 🔵 REST API — Controllers / JSON/XML

**What it is:** The Spring MVC REST controllers that handle all HTTP API requests from the frontend and external clients.

**Where it lives:** Every domain module under `src/main/java/org/openelisglobal/` has a `controller/` sub-package (100+ controllers total).

**Key base class:** `common/controller/BaseController.java`

```OpenELIS-Global-2/src/main/java/org/openelisglobal/common/controller/BaseController.java#L30-45
@Component
public abstract class BaseController extends ControllerUtills implements IActionConstants {

    @Autowired
    protected HttpServletRequest request;

    @Autowired
    protected UserModuleService userModuleService;
    @Autowired
    protected PageBuilderService pageBuilderService;

    protected abstract String findLocalForward(String forward);
```

**How the REST layer is structured:**
- **`/rest/**`** endpoints → JSON REST controllers (e.g., `AlertRestController`, `TestReflexRuleRestController`, `AccessionValidationRestController`)
- **`/Provider/**`** endpoints → Legacy XML/JSON providers
- Controllers **never call DAOs directly** — they delegate only to Services (constitution rule IV enforced)
- Security routes are defined in `SecurityConfig.java`:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/SecurityConfig.java#L108-108
public static final String[] REST_CONTROLLERS = { "/Provider/**", "/rest/**" };
```

Real examples of REST controllers in the project:
- `alert/controller/rest/AlertRestController.java`
- `resultvalidation/controller/rest/AccessionValidationRestController.java`
- `testreflex/controller/rest/TestReflexRuleRestController.java`

---

## 3. 🟢 FHIR R4 API — HAPI FHIR / HL7 Standard

**What it is:** The healthcare interoperability layer, exposing and consuming FHIR R4 resources following the HL7 standard.

**Where it lives:**
- `src/main/java/org/openelisglobal/fhir/` — internal FHIR server (HAPI FHIR RestfulServer)
- `src/main/java/org/openelisglobal/dataexchange/fhir/` — FHIR transformation + sync services
- `docker-compose.yml` → `fhir.openelis.org` — an **external** dedicated HAPI FHIR server container (port 8081/8444)

**The internal FHIR Restful Server:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/fhir/servlets/FhirRestfulServer.java#L12-35
public class FhirRestfulServer extends RestfulServer {

    @Override
    protected void initialize() throws ServletException {
        super.initialize();
        setFhirContext(FhirContext.forR4());   // FHIR R4 context
        Map<String, IResourceProvider> providerMap = 
            applicationContext.getBeansOfType(IResourceProvider.class);
        List<IResourceProvider> providers = new ArrayList<>(providerMap.values());
        setResourceProviders(providers);  // e.g. PractitionerProvider
    }
}
```

**The key FHIR services:**

| Service | Responsibility |
|---|---|
| `FhirTransformService` | Transforms OpenELIS domain objects ↔ FHIR R4 resources (Patient, DiagnosticReport, Observation, etc.) |
| `FhirPersistanceService` | Creates/updates FHIR resources on the local or remote FHIR store |
| `FhirApiWorkflowService` | Polls remote FHIR stores for new orders (Tasks), interprets and processes them |
| `FhirConfig` | Configures the HAPI FHIR R4 client, HTTP client, local + remote store URIs |

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/fhir/service/FhirTransformService.java#L33-50
void transformPersistPatient(PatientManagementInfo patientInfo, boolean isCreate)
        throws FhirTransformationException, FhirPersistanceException;

void transformPersistOrderEntryFhirObjects(SamplePatientUpdateData updateData, ...)
        throws FhirTransformationException, FhirPersistanceException;

void transformPersistResultsEntryFhirObjects(ResultsUpdateDataSet actionDataSet)
        throws FhirTransformationException, FhirPersistanceException;
```

Every patient, order, and result entered in OpenELIS is **simultaneously transformed into FHIR R4 resources** and synced to the HAPI FHIR server.

---

## 4. 🟡 Analyzer Handler — ASTM LIS2-A2 / HL7 v2.x

**What it is:** The lab instrument integration layer. It receives raw data from physical analyzers (Cobas, Sysmex, FACS Canto, etc.) and imports those results into OpenELIS.

**Where it lives:**
- `src/main/java/org/openelisglobal/analyzerimport/analyzerreaders/` — all analyzer protocol readers
- `src/main/java/org/openelisglobal/analyzerimport/` — full controller/service/DAO stack

**Supported protocols and instruments:**

| Reader Class | Protocol / Instrument |
|---|---|
| `ASTMAnalyzerReader.java` | **ASTM LIS2-A2** (generic) |
| `HL7AnalyzerReader.java` | **HL7 v2.x** (generic) |
| `SerialAnalyzerReader.java` | Serial port communication |
| `CSVAnalyzerReader.java` | CSV file upload |
| `CobasReader.java`, `CobasC311Reader.java` | Roche Cobas instruments |
| `CobasTaqmanReader.java` | Cobas TaqMan (HIV viral load) |
| `SysmexReader.java` | Sysmex hematology analyzers |
| `FACSCantoReader.java`, `FacscaliburReader.java` | BD FACS flow cytometers |
| `EvolisReader.java` | Evolis card printers |

**How ASTM LIS2-A2 works (the main protocol):**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/analyzerimport/analyzerreaders/ASTMAnalyzerReader.java#L86-102
public boolean processData(String currentUserId) {
    ensureInserterResponder();
    if (plugin == null) {
        error = "No ASTM plugin matched this message";
        return false;
    }
    if (plugin.isAnalyzerResult(lines)) {
        return insertAnalyzerData(currentUserId); // result message → save to DB
    } else {
        responseBody = buildResponseForQuery(); // query message → send back response
        hasResponse = true;
        return true;
    }
}
```

- The system is **plugin-driven** — each analyzer has a plugin (`AnalyzerImporterPlugin`) registered via the `PluginAnalyzerService`
- It identifies the analyzer by **parsing the ASTM H-segment** (manufacturer/model) or by **client IP address**
- It supports **analyzer result mappings** via `MappingAwareAnalyzerLineInserter` — mapping analyzer test codes to OpenELIS test codes

---

## 5. 🔴 Authentication — SAML 2.0 / SSO / Keycloak

**What it is:** A multi-strategy authentication layer supporting local login, SAML 2.0 SSO, OpenID Connect (Keycloak), HTTP Basic, and client certificates.

**Where it lives:**
- `src/main/java/org/openelisglobal/security/SecurityConfig.java` — the master Spring Security configuration
- `src/main/java/org/openelisglobal/security/login/` — login-specific handlers
- `src/main/java/org/openelisglobal/login/` — login domain (DAO/Service/Controller)

**All 5 authentication strategies in SecurityConfig:**

| Order | Filter Chain | Method | Trigger |
|---|---|---|---|
| 1 | `openSecurityFilterChain` | None (public pages) | Matches `OPEN_PAGES` |
| 2 | `httpBasicServletFilterChain` | HTTP Basic Auth | `Authorization: Basic` header |
| 3 | `samlSecurityFilterChain` | **SAML 2.0 / Keycloak** | `/saml2/**` URL prefix |
| 4 | `openidSecurityFilterChain` | **OpenID Connect / OAuth2** | OAuth2 request matcher |
| 5 | `defaultSecurityFilterChain` | Form login | All other requests |

**SAML / Keycloak configuration:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/security/SecurityConfig.java#L182-204
@Value("${org.itech.login.saml.registrationId:keycloak}")
private String registrationId;

@Value("${org.itech.login.saml.entityId:OpenELIS-Global_saml}")
private String entityId;

@Value("${org.itech.login.saml.metadatalocation:}")
private String metadata;

@Value("${org.itech.login.saml.idpEntityId:}")
private String idpEntityId;

@Value("${org.itech.login.saml.webSSOEndpoint:}")
```

All auth strategies share:
- Custom `AuthenticationSuccessHandler` and `AuthenticationFailureHandler` for each strategy
- `PasswordEncoder` (BCrypt)
- `HttpSessionEventPublisher` for session tracking
- Content Security Policy headers on all pages

---

## 6. 🔵 Service Layer — Business Logic / Spring Services

**What it is:** The heart of the application. All business logic lives here, between Controllers (above) and DAOs (below). Every module has a `service/` package.

**Where it lives:** Every domain module has `service/` + `service/*ServiceImpl.java` pairs. Key examples:
- `sample/service/SamplePatientEntryServiceImpl.java` — order entry workflow
- `resultvalidation/service/ResultValidationServiceImpl.java` — result validation
- `common/services/ResultSaveService.java` — result persistence
- `common/services/StatusService.java` — status state machine
- `dataexchange/fhir/service/FhirApiWorkflowServiceImpl.java` — FHIR sync workflow

**The service contract for result validation:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/resultvalidation/service/ResultValidationService.java#L13-18
public interface ResultValidationService {
    void persistdata(List<Result> deletableList, List<Analysis> analysisUpdateList,
            ArrayList<Result> resultUpdateList, List<AnalysisItem> resultItemList,
            ArrayList<Sample> sampleUpdateList, ArrayList<Note> noteUpdateList,
            IResultSaveService resultSaveService, List<IResultUpdate> updaters, String sysUserId);
}
```

Key architectural rules enforced here:
- `@Transactional` annotations live on Service classes, **not** Controllers
- Services compile all required data within the transaction to avoid `LazyInitializationException`
- Services use **observer/registration patterns** (`ResultUpdateRegister`, `ValidationUpdateRegister`) for cross-cutting concerns

---

## 7. 🟢 Workflow Engine — Order → Sample → Result / Validation Rules

**What it is:** The core lab workflow that drives a specimen through its lifecycle: from order entry → sample accessioning → test analysis → result entry → validation → reporting.

**Where it lives (the full workflow pipeline):**

```
sample/service/SamplePatientEntryServiceImpl.java   → Order + Patient entry
sample/service/SampleEditServiceImpl.java            → Sample modification
analysis/service/AnalysisServiceImpl.java            → Per-test analysis tracking
result/service/ResultServiceImpl.java                → Result capture
testreflex/service/TestReflexServiceImpl.java        → Reflexive test rules
resultvalidation/service/ResultValidationServiceImpl → Validation & approval
resultreporting/                                     → Report generation
```

**Reflex (workflow) rules:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/testreflex/action/util/TestReflexUtil.java#L1-1
// Handles: if Test A result = X, then automatically order Test B
```

The `testreflex` module implements configurable rules (conditions + actions) that automatically trigger additional tests based on result values — a core clinical workflow feature.

**Status state machine** (`StatusService`) tracks every sample and analysis through states: `Entered → Collected → Received → In Progress → Completed → Validated → Released`.

---

## 8. 🟡 Validation Engine — Reference Ranges / QC Rules / Alerts

**What it is:** The clinical quality control system that validates results against reference ranges and QC rules, and fires alerts when values are outside acceptable bounds.

**Where it lives:**
- `resultlimit/service/ResultLimitServiceImpl.java` — reference range definitions
- `resultvalidation/util/ResultsValidationUtility.java` — validation logic
- `resultvalidation/bean/AnalysisItem.java` — carries validation state per test
- `alert/` — full alert system (DAO/Service/Controller/Events)

**Alert lifecycle (event-driven):**

```
alert/event/AlertCreatedEvent.java      → fired when result out of range
alert/event/AlertAcknowledgedEvent.java → lab supervisor acknowledges
alert/event/AlertResolvedEvent.java     → alert cleared
alert/service/AlertNotificationService  → pushes notifications
```

**What gets validated:**
- **Reference Ranges:** age/sex/pregnancy-specific normal ranges per test (stored via `ResultLimit`)
- **QC Rules:** Westgard rules and custom QC rule logic
- **Critical values:** automatic alerts to clinicians when results exceed panic values
- **Accession validation range:** `AccessionValidationRestController` — validates entire sample accessions

---

## 9. 🔵 Data Access Layer — Hibernate / JPA / ORM / Repositories / Transaction Management

**What it is:** The entire persistence layer. Every domain entity has a DAO interface and implementation backed by Hibernate/JPA via `EntityManager`.

**Where it lives:**
- `common/daoimpl/BaseDAOImpl.java` — the base class for ALL DAOs (~100 DAOs extend this)
- Every domain module has `dao/` + `daoimpl/` packages

**The base DAO uses `jakarta.persistence` (not `javax.*`) and Hibernate:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/common/daoimpl/BaseDAOImpl.java#L50-80
@Component
@DependsOn({ "defaultConfigurationProperties", "springContext" })
@Transactional
public abstract class BaseDAOImpl<T extends BaseObject<PK>, PK extends Serializable>
        implements BaseDAO<T, PK>, IActionConstants {

    @PersistenceContext
    protected EntityManager entityManager;
```

**The `BaseDAO<T, PK>` interface provides a comprehensive generic API:**
- `get(PK id)`, `getAll()`, `getAllMatching(...)`, `getAllOrdered(...)`, `getPage(...)`, `insert(T)`, `update(T)`, `delete(T)`, `getCount()`, `getNext(id)`, `getPrevious(id)` — and many paginated/sorted variants

**Schema management via Liquibase** (constitution rule VI enforced):

```
src/main/resources/liquibase/
    2.0.x.x/   → base schema
    2.1.x.x/   → client notifications, external connections
    2.2.x.x/   → email/SMS expansion
    2.3.x.x/   → accession validation, FHIR UUIDs, analyzer experiments
    ...up to 2.9.x.x and beyond
```

Every schema change is a versioned XML changeset — **no direct DDL** in Java code.

---

## 10. 🟢 FHIR Resource Manager — Resource Transformation / Sync

**What it is:** The bridge between the OpenELIS internal data model and the external FHIR R4 standard. It transforms domain objects into FHIR resources and keeps them in sync.

**Where it lives:**
- `dataexchange/fhir/service/FhirTransformServiceImpl.java` — transforms every entity
- `dataexchange/fhir/service/FhirPersistanceServiceImpl.java` — persists to FHIR store
- `dataexchange/fhir/service/FhirApiWorkflowServiceImpl.java` — polls + processes incoming orders
- `dataexchange/fhir/FhirConfig.java` — configures HAPI FHIR R4 client + endpoints

**Transform coverage:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/fhir/service/FhirTransformService.java#L33-70
transformPersistPatient(...)            // Patient → FHIR Patient
transformPersistOrganization(...)       // Org → FHIR Organization  
transformPersistOrderEntryFhirObjects(...)  // Sample → FHIR ServiceRequest + Task
transformPersistResultsEntryFhirObjects(...)// Result → FHIR DiagnosticReport + Observation
transformPersistResultValidationFhirObjects(...) // Validation → FHIR update
transformToFhirPatient(String patientId)
transformAnalysisByIds(List<String> analysisIds)
```

**The FHIR sync topology** (from `docker-compose.yml`):
- **Local FHIR store:** `fhir.openelis.org` container (HAPI FHIR server, port 8081)
- **Remote FHIR stores:** configurable via `org.openelisglobal.remote.source.uri` — can sync with OpenHIM, DHIS2, or other IHE-compliant systems
- **Client Registry:** configurable via `org.openelisglobal.crserver.uri` — links patients across systems using FHIR Patient resources

---

## 📊 How Everything Connects

```
Browser/Client
      ↓ HTTPS
   [Nginx] → SSL termination, routes /api, /rest, /fhir
      ↓
[Authentication] → SAML/SSO/Keycloak/Basic/Form Login (SecurityConfig.java)
      ↓
[REST API Controllers] → 100+ Spring MVC controllers (BaseController hierarchy)
      ↓
[Service Layer] → Business logic, @Transactional boundaries, Spring Services
      ↙              ↘
[Workflow Engine]  [Validation Engine]
 Order→Sample→Result  Reference Ranges, QC, Alerts
      ↓
[Data Access Layer] → BaseDAOImpl + EntityManager + Hibernate/JPA
      ↓
[PostgreSQL DB] (schema managed by Liquibase)
      ↕
[FHIR Resource Manager] → FhirTransformService + FhirPersistanceService
      ↕
[FHIR R4 API] → HAPI FHIR RestfulServer (internal) + external HAPI FHIR container
      ↕
[Analyzer Handler] → ASTM LIS2-A2/HL7v2 readers → plugin-based instrument integrations
```

This is a well-structured, **mission-critical healthcare LIMS** with clear separation of concerns across all 5 architectural layers.
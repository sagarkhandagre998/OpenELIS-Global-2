The New FHIR Facade Architecture — Step by Step with Real Examples from the Code

---

### The Single Most Important Concept to Understand First

The entire project lives on this one insight:

**Current system:** "FHIR is a separate database you sync to."
**New system:** "FHIR is a query language that speaks directly to OpenELIS's own database."

The proof that this is already partially started is in `AnnotationWebAppInitializer.java`:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/config/AnnotationWebAppInitializer.java#L35-38
ServletRegistration.Dynamic fhirServlet = servletContext.addServlet("FhirServlet",
        new FhirRestfulServer(rootContext));
fhirServlet.setLoadOnStartup(++startupOrder);
fhirServlet.addMapping("/fhir/facade/*");
```

The `FhirRestfulServer` is already registered and serving at `/fhir/facade/*`. It already scans for `IResourceProvider` beans:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/fhir/servlets/FhirRestfulServer.java#L24-31
Map<String, IResourceProvider> providerMap = applicationContext.getBeansOfType(IResourceProvider.class);
List<IResourceProvider> providers = new ArrayList<>(providerMap.values());
setResourceProviders(providers);
```

And there is already **one real working provider** — `PractitionerProvider`. This is the proof-of-concept the new architecture is built around. Everything below is the full architecture derived from how that one provider works, scaled across all FHIR resources OpenELIS handles.

---

### Step 1 — What a FHIR Facade Provider Actually Is

A **FHIR Resource Provider** (`IResourceProvider`) is a Spring `@Component` that tells HAPI's Plain Server: "I handle HTTP requests for this FHIR resource type. Call my methods."

Think of it like a REST Controller, but instead of mapping `@GetMapping("/patient/{id}")`, HAPI's framework reads FHIR-specific annotations and routes automatically.

The existing `PractitionerProvider` shows the exact pattern:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/fhir/providers/PractitionerProvider.java#L30-45
@Component
public class PractitionerProvider implements IResourceProvider {

    @Autowired
    private FhirTransformService fhirTransformService;

    @Autowired
    private FhirPersistanceService fhirPersistenceService;  // ← still called, but only as fallback

    @Autowired
    private ProviderService providerService;   // ← the REAL OpenELIS service
    @Autowired
    private PersonService personService;       // ← the REAL OpenELIS service

    @Override
    public Class<? extends IBaseResource> getResourceType() {
        return Practitioner.class;
    }
```

This provider has **two separate methods** for write operations, annotated with HAPI annotations:

- `@Create` → handles `POST /fhir/facade/Practitioner`
- `@Update` → handles `PUT /fhir/facade/Practitioner/{id}`

Notice what the `@Create` method does — this is the key pattern:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/fhir/providers/PractitionerProvider.java#L53-90
@Create
public MethodOutcome create(@ResourceParam Practitioner practitioner, HttpServletRequest request) {
    // 1. Parse incoming FHIR Practitioner → transform to OpenELIS Provider domain object
    Provider provider = fhirTransformService.transformToProvider(practitioner);
    provider.getPerson().setSysUserId(ControllerUtills.getSysUserId(request));

    // 2. Save directly into clinlims PostgreSQL through OpenELIS service layer
    Person savedPerson = personService.save(provider.getPerson());
    provider.setPerson(savedPerson);
    Provider providerTosave = providerService.save(provider);

    // 3. Transform back to FHIR to build the response
    Practitioner practitionerToSave = fhirTransformService.transformProviderToPractitioner(providerTosave);

    // 4. Try to sync to HAPI (still present but demoted to best-effort)
    try {
        fhirPersistenceService.updateFhirResourceInFhirStore(practitionerToSave);
    } catch (Exception syncEx) {
        LogEvent.logError(...); // logs but DOES NOT fail the operation
    }

    // 5. Return the created resource
    MethodOutcome outcome = new MethodOutcome();
    outcome.setId(practitionerToSave.getIdElement());
    outcome.setResource(practitionerToSave);
    outcome.setCreated(true);
    return outcome;
}
```

This is a **write-through facade**: the write goes straight to `personService.save()` and `providerService.save()` — into `clinlims` PostgreSQL. The HAPI sync is a try-catch that is allowed to fail silently. Postgres is now the single authority.

---

### Step 2 — The Three Flows the Facade Must Handle Per Resource

For every FHIR resource type, the facade needs to handle three distinct operations:

**Flow A — External System Reads (GET)**
An external system wants to read a patient.
```/dev/null/flow.txt#L1-3
GET /fhir/facade/Patient/abc-123-uuid
→ PatientProvider.read(IdType)
→ patientService.get(clinlimsPatientId)  [looked up via fhir_uuid column]
→ fhirTransformService.transformToFhirPatient(patient)
→ returns FHIR Patient JSON
```

**Flow B — External System Writes (POST/PUT)**
An external system creates or updates data.
```/dev/null/flow.txt#L5-8
POST /fhir/facade/Patient  { "resourceType":"Patient", "name":[...], ...}
→ PatientProvider.create(Patient fhirPatient)
→ fhirTransformService parse Patient fields → OpenELIS Patient valueholder
→ patientService.save(patient)  [writes to clinlims.patient table]
→ returns 201 Created with saved FHIR Patient
```

**Flow C — External System Searches (GET with params)**
An external system queries for resources.
```/dev/null/flow.txt#L10-13
GET /fhir/facade/Patient?family=Smith&birthdate=1980-01-01
→ PatientProvider.search(StringParam family, DateParam birthdate)
→ patientService.getPatientsByName("Smith")  [queries clinlims directly]
→ fhirTransformService.transformToFhirPatient(each patient)
→ returns FHIR Bundle of matching Patient resources
```

---

### Step 3 — The Complete Resource Mapping (FHIR ↔ OpenELIS Domain)

Every FHIR resource that needs a provider maps to specific OpenELIS domain objects already in `clinlims`. These mappings are already proven by `FhirTransformServiceImpl`:

**Resource 1: `Patient` ↔ `Patient` + `Person` + `PatientIdentity`**

The `fhir_uuid` column on the `patient` table is the stable FHIR ID. The transform already exists in `FhirTransformServiceImpl.transformToFhirPatient()` (lines 745–793). What's missing is a `PatientProvider` class with `@Create`, `@Update`, `@Read`, `@Search` operations.

For `@Read`:
```/dev/null/PatientProvider.java#L1-8
@Read
public Patient read(@IdParam IdType theId) {
    // fhir_uuid is the FHIR ID
    Patient oePatient = patientService.getAllPatients().stream()
        .filter(p -> theId.getIdPart().equals(p.getFhirUuidAsString()))
        .findFirst().orElseThrow(() -> new ResourceNotFoundException(theId));
    return fhirTransformService.transformToFhirPatient(oePatient.getId());
}
```

For `@Create`, parse the incoming FHIR Patient using `FhirTransformServiceImpl.transformToOpenElisPatientSearchResults()` which already does FHIR→OE conversion (lines 796–851), then create the patient via `patientService.persistPatientData()`.

**Resource 2: `Task` ↔ `Sample`**

`Sample` in OpenELIS IS a `Task` in FHIR. The mapping is in `FhirTransformServiceImpl.transformToTask(Sample)` (lines 621–669). The `sample.fhir_uuid` column is the Task's FHIR ID. The task status maps directly:

```/dev/null/mapping.txt#L1-8
OrderStatus.Entered    → TaskStatus.READY
OrderStatus.Started    → TaskStatus.INPROGRESS
OrderStatus.Finished   → TaskStatus.COMPLETED
AnalysisStatus.TechnicalRejected → TaskStatus.FAILED
AnalysisStatus.BiologistRejected → TaskStatus.REJECTED
```

For inbound Task creation (Scenario B — an order coming in), the facade `TaskProvider.create()` would call `TaskWorker` → `DBOrderPersister.persist()`, which is the exact same code `FhirApiWorkFlowServiceImpl.processTaskImportOrder()` calls, but now it's triggered by a direct HTTP POST instead of a scheduled poll.

**Resource 3: `ServiceRequest` ↔ `Analysis`**

`Analysis` in OpenELIS IS a `ServiceRequest` in FHIR. The mapping is `FhirTransformServiceImpl.transformToServiceRequest(Analysis)` (lines 926–1009). The `analysis.fhir_uuid` column is the ServiceRequest's FHIR ID.

**Resource 4: `Specimen` ↔ `SampleItem`**

`SampleItem` IS a `Specimen`. The mapping is `FhirTransformServiceImpl.transformToSpecimen(SampleItem)` (lines 1064–1090). The `sample_item.fhir_uuid` column is the Specimen's FHIR ID.

**Resource 5: `Observation` ↔ `Result`**

`Result` IS an `Observation`. The mapping is `FhirTransformServiceImpl.transformResultToObservation(Result)` (lines 1379–1470). The `result.fhir_uuid` column is the Observation's FHIR ID.

**Resource 6: `DiagnosticReport` ↔ `Analysis` (when finalized)**

A finalized `Analysis` with its `Result` set produces a `DiagnosticReport`. The mapping is `FhirTransformServiceImpl.transformResultToDiagnosticReport(Analysis)` (lines 1325–1359).

**Resource 7: `Practitioner` ↔ `Provider` + `Person`**

Already **fully implemented** in `PractitionerProvider`. The `provider.fhir_uuid` is the Practitioner's FHIR ID.

**Resource 8: `Organization` ↔ `Organization`**

The mapping is `FhirTransformServiceImpl.transformToFhirOrganization(Organization)` (lines 1500–1513). The `organization.fhir_uuid` column is the Organization's FHIR ID.

---

### Step 4 — How the Routing Already Works End to End

The routing chain is already wired. Here is the complete path a request takes today when it hits `POST /fhir/facade/Practitioner`:

```/dev/null/routing.txt#L1-12
[External Client]
    ↓ HTTP POST /fhir/facade/Practitioner
[nginx proxy]   (docker-compose.yml: proxy container)
    ↓ forwards to oe.openelis.org:8080
[Tomcat]
    ↓ matches /fhir/facade/* → routes to FhirRestfulServer servlet
[FhirRestfulServer.initialize()]
    ↓ already has PractitionerProvider registered as IResourceProvider bean
[HAPI Plain Server framework]
    ↓ sees "Practitioner" resource type, sees POST method → calls @Create annotated method
[PractitionerProvider.create()]
    ↓ calls personService.save() + providerService.save()
[clinlims PostgreSQL]  ← DATA LANDS HERE, DIRECTLY, NO SECOND SERVER
```

The test `PractitionerFacadeTest` proves this exact chain works today:

```OpenELIS-Global-2/src/test/java/org/openelisglobal/fhir/PractitionerFacadeTest.java#L80-120
@Test
public void createPractitioner_shouldReturnSuccess() throws Exception {
    MockHttpServletRequest request = buildRequest("POST");
    String practitionerJson = """
        { "resourceType": "Practitioner", "name": [{"family": "Patric", "given": ["Onyango"]}], ... }
    """;
    request.setContent(practitionerJson.getBytes());
    MockHttpServletResponse response = new MockHttpServletResponse();

    fhirServlet.service(request, response);    // goes through real HAPI routing

    assertEquals(201, response.getStatus());

    List<Provider> savedProviders = providerService.getAll();  // checks REAL clinlims DB
    assertTrue(savedProviders.size() > 0);          // FHIR write landed in Postgres directly
    assertEquals("patric.onyango@example.com", savedPeople.get(0).getEmail());
}
```

No HAPI JPA server involved. No async. No sync drift possible.

---

### Step 5 — What `InternalFhirApi` Does and Why It Matters

There is an important bridge controller, `InternalFhirApi`, that acts as the **public-facing FHIR endpoint** on `/fhir/**`:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/fhir/controller/InternalFhirApi.java#L47-66
@GetMapping("/**")
public ResponseEntity<Object> recieveGetFhirRequests(HttpServletRequest request) {
    return forwardGetRequest(request);   // GETs → forwarded to HAPI external store (still)
}

@PostMapping("/**")
public void receivePostFhirRequest(HttpServletRequest request, HttpServletResponse response) {
    forwardToFacade(request, response);  // POSTs → forwarded to /fhir/facade/* (the new facade)
}

@PutMapping("/{resourceType}/**")
public void receivePutFhirRequest(...) {
    forwardToFacade(request, response);  // PUTs → forwarded to /fhir/facade/* (the new facade)
}
```

This is a **hybrid routing layer** — it's the current transition state. Writes (`POST`/`PUT`) already go to the facade. Reads (`GET`) still go to the old HAPI external store. As each `IResourceProvider` gets a `@Read` and `@Search` operation implemented, the GET routing in `InternalFhirApi` can be changed to `forwardToFacade` as well, until eventually the external HAPI server is no longer needed at all.

---

### Step 6 — The Limitation the Current `PractitionerProvider` Still Has

Even though `PractitionerProvider` is the working model, it still has the old sync artifact:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/fhir/providers/PractitionerProvider.java#L73-79
try {
    fhirPersistenceService.updateFhirResourceInFhirStore(practitionerToSave);
} catch (Exception syncEx) {
    LogEvent.logError(this.getClass().getSimpleName(), method,
            "FHIR store sync failed (continuing anyway): " + syncEx.getMessage());
}
```

And it still uses `new FhirTransformServiceImpl()` directly in the update method — which is a Spring anti-pattern (instantiating a Spring bean manually):

```OpenELIS-Global-2/src/main/java/org/openelisglobal/fhir/providers/PractitionerProvider.java#L123-125
FhirTransformServiceImpl transForm = new FhirTransformServiceImpl();
transForm.addHumanNameToPerson(practitioner.getNameFirstRep(), existingPerson);
transForm.addTelecomToPerson(practitioner.getTelecom(), existingPerson);
```

These are two known problems that need to be fixed in `PractitionerProvider` and avoided in all future providers.

---

### Step 7 — The Complete Target Architecture Summarized

Once all resource providers are built, the architecture becomes:

```/dev/null/final-architecture.txt#L1-25
External FHIR Client
        ↓
  NGINX Proxy
        ↓
  InternalFhirApi  (/fhir/**)
        ↓   (all methods: GET, POST, PUT, DELETE)
  FhirRestfulServer  (/fhir/facade/*)  [HAPI Plain Server]
        ↓   [routes by resource type + HTTP method]
  ┌──────────────────────────────────────────┐
  │  PatientProvider      → PatientService   │
  │  TaskProvider         → SampleService    │
  │  ServiceReqProvider   → AnalysisService  │
  │  SpecimenProvider     → SampleItemService│
  │  ObservationProvider  → ResultService    │
  │  DiagReportProvider   → AnalysisService  │
  │  PractitionerProvider → ProviderService  │ ← already done
  │  OrganizationProvider → OrgService       │
  └──────────────────────────────────────────┘
        ↓   (direct Java method calls, no HTTP, no network)
  clinlims PostgreSQL  ← THE ONLY DATABASE
```

The HAPI FHIR JPA server container (`fhir.openelis.org`) becomes optional infrastructure for systems that need FHIR subscription notifications — but it is no longer the system of record. `FhirApiWorkflowService` polling is replaced by direct HTTP Posts to the facade. `SampleFhirTransformEventListener`, `FhirTransformationController` boot-time scans, and `RegisterFhirHooksTask` subscriptions all become unnecessary because there is nothing to sync — reads and writes go directly through the facade into Postgres.
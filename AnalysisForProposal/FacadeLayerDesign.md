OpenELIS FHIR Facade — Complete Architectural Design

---

### 1. The Core Design Problem, Precisely Stated

Before any diagram, you need to understand the **exact structural contradiction** in the current system. Every line of code confirms it:

```/dev/null/current-problem.txt#L1-1
The current system has TWO independent sources of truth that are kept in sync by fragile, async, best-effort code.
```

Here is the complete picture of that contradiction drawn from the actual code:

```/dev/null/contradiction.txt#L1-30
┌─────────────────────────────────────────────────────────────────────────┐
│                     SOURCE OF TRUTH #1                                  │
│                                                                         │
│  clinlims  (PostgreSQL)                                                 │
│  ──────────────────────────────────────────────────────────────────     │
│  patient        (has fhir_uuid column)                                  │
│  sample         (has fhir_uuid column)   ← Sample IS a Task            │
│  analysis       (has fhir_uuid column)   ← Analysis IS a ServiceRequest│
│  sample_item    (has fhir_uuid column)   ← SampleItem IS a Specimen    │
│  result         (has fhir_uuid column)   ← Result IS an Observation    │
│  provider       (has fhir_uuid column)   ← Provider IS a Practitioner  │
│  organization   (has fhir_uuid column)                                  │
│  referral       (has fhir_uuid column)                                  │
└────────────────────────┬────────────────────────────────────────────────┘
                         │
              async, best-effort HTTP
              (can fail silently,
               scheduled every 2 min
               for inbound,
               boot-time scan to repair)
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     SOURCE OF TRUTH #2                                  │
│                                                                         │
│  HAPI FHIR JPA Server  (separate Docker container)                     │
│  ──────────────────────────────────────────────────────────────────     │
│  Patient / Task / ServiceRequest / Specimen                             │
│  Observation / DiagnosticReport / Practitioner / Organization           │
│  (stored in its own JPA tables, also in PostgreSQL)                     │
└─────────────────────────────────────────────────────────────────────────┘
```

The `fhir_uuid` columns in `clinlims` are the proof that Source of Truth #1 already knows exactly what FHIR IDs its objects should have. It does not need a second database. The new architecture removes Source of Truth #2 entirely and makes the facade read directly from Source of Truth #1.

---

### 2. The New Architecture — Master Design Diagram

```/dev/null/master-architecture.txt#L1-80
╔══════════════════════════════════════════════════════════════════════════════╗
║                    EXTERNAL SYSTEMS  (FHIR R4 Clients)                      ║
║                                                                              ║
║    iSante    OpenMRS    Another-Lab    SHR    OpenCR    Custom-App           ║
╚══════════════════════════╤═══════════════════════════════════════════════════╝
                           │  Standard FHIR R4 REST  (HTTP/HTTPS)
                           │  GET / POST / PUT / DELETE / Bundle transactions
                           ▼
╔══════════════════════════════════════════════════════════════════════════════╗
║                         NGINX Proxy                                          ║
║                    (reverse proxy, TLS termination)                          ║
╚══════════════════════════╤═══════════════════════════════════════════════════╝
                           │
                           ▼
╔══════════════════════════════════════════════════════════════════════════════╗
║               InternalFhirApi   (@RestController  /fhir/**)                 ║
║                                                                              ║
║   GET  /fhir/**  ──────────────────────────────────────────►  forwardToFacade ║
║   POST /fhir/**  ──────────────────────────────────────────►  forwardToFacade ║
║   PUT  /fhir/{resourceType}/**  ───────────────────────────►  forwardToFacade ║
║                                                                              ║
║   (single entry point — all FHIR traffic enters here)                        ║
╚══════════════════════════╤═══════════════════════════════════════════════════╝
                           │  RequestDispatcher.forward()
                           │  rewrites path: /fhir/** → /fhir/facade/**
                           ▼
╔══════════════════════════════════════════════════════════════════════════════╗
║             FhirRestfulServer  (HAPI Plain Server Servlet)                  ║
║                  registered at  /fhir/facade/*                              ║
║                                                                              ║
║   Content-Type negotiation  │  FHIR validation  │  Error serialization      ║
║                                                                              ║
║   Routes by ResourceType + HTTP Method to IResourceProvider beans           ║
╚══╤═════════╤══════════╤═══════════╤════════════╤═════════╤══════════════════╝
   │         │          │           │            │         │
   ▼         ▼          ▼           ▼            ▼         ▼
Patient   Task     ServiceReq   Specimen   Observation  DiagReport
Provider  Provider Provider     Provider   Provider     Provider
   │         │          │           │            │         │
   │         │          │           │            │         │
╔══╧═════════╧══════════╧═══════════╧════════════╧═════════╧══════════════════╗
║                                                                              ║
║                    OpenELIS  SERVICE LAYER                                  ║
║   ─────────────────────────────────────────────────────────────────────     ║
║   PatientService    SampleService     AnalysisService    ResultService       ║
║   SampleItemService ProviderService   OrganizationService                   ║
║                                                                              ║
║   FhirTransformService  (READ path: OE domain → FHIR R4 Resource)           ║
║                                                                              ║
╚══════════════════════════════════╤═══════════════════════════════════════════╝
                                   │  Hibernate ORM  (HBM mappings)
                                   ▼
╔══════════════════════════════════════════════════════════════════════════════╗
║                                                                              ║
║            clinlims  (PostgreSQL  — THE ONLY DATABASE)                      ║
║   ─────────────────────────────────────────────────────────────────────     ║
║   patient(fhir_uuid)  sample(fhir_uuid)   analysis(fhir_uuid)               ║
║   result(fhir_uuid)   sample_item(fhir_uuid)  provider(fhir_uuid)           ║
║   organization(fhir_uuid)  referral(fhir_uuid)                              ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

---

### 3. The Three-Layer Design Inside Every Provider

Every `IResourceProvider` is a **three-layer translation boundary**. Understanding this boundary is the entire design:

```/dev/null/three-layers.txt#L1-50
                 FHIR WORLD                     OE WORLD
                    │                              │
                    │                              │
  FHIR R4 JSON ─────┼─── LAYER 1: ROUTING ────────┼──────
                    │   (HAPI annotations decide   │
                    │    which method gets called) │
                    │                              │
                    │                              │
  Practitioner ─────┼─── LAYER 2: TRANSLATION ────┼── Provider + Person
  Patient       ────┼   (FhirTransformService)  ──┼── Patient + Person + PatientIdentity
  Task          ────┼   maps FHIR ↔ OE domain   ──┼── Sample
  ServiceRequest────┼   objects bidirectionally  ──┼── Analysis
  Specimen      ────┼                            ──┼── SampleItem
  Observation   ────┼                            ──┼── Result
  DiagReport    ────┼                            ──┼── Analysis (finalized)
  Organization  ────┼                            ──┼── Organization
                    │                              │
                    │                              │
     ───────────────┼─── LAYER 3: PERSISTENCE ─────┼──────
                    │   (OE Service layer)          │
                    │   patientService.save()       │
                    │   sampleService.insert()      │
                    │   analysisService.update()    │
                    │   → Hibernate → clinlims PG   │
                    │                              │
```

---

### 4. Read Path Design (GET) — Detailed

This is how every `@Read` and `@Search` operation works architecturally:

```/dev/null/read-path.txt#L1-55
Client: GET /fhir/facade/Patient/3a7c-f482-...uuid...
                    │
                    ▼
       FhirRestfulServer  identifies:
       resourceType = Patient
       operation   = READ
       id          = "3a7c-f482-...uuid..."
                    │
                    ▼
       PatientProvider.read(IdType theId)
                    │
           ┌────────┴─────────────────────────────────┐
           │  LOOKUP STEP                             │
           │                                          │
           │  The fhir_uuid column in clinlims.patient│
           │  IS the FHIR resource ID.                │
           │                                          │
           │  patientService.getMatch(                │
           │    "fhirUuid",                           │
           │    UUID.fromString(theId.getIdPart())    │
           │  )                                       │
           │  → HQL: FROM Patient WHERE fhirUuid = ? │
           │  → Returns: OE Patient valueholder       │
           └────────┬─────────────────────────────────┘
                    │
                    ▼
           ┌────────┴─────────────────────────────────┐
           │  TRANSLATION STEP (READ PATH)            │
           │                                          │
           │  fhirTransformService                    │
           │    .transformToFhirPatient(patient.getId)│
           │                                          │
           │  Reads:                                  │
           │    patient.fhirUuid  → Patient.id        │
           │    person.firstName  → Patient.name.given│
           │    person.lastName   → Patient.name.family│
           │    patient.gender    → Patient.gender    │
           │    patient.birthDate → Patient.birthDate │
           │    patientIdentity[] → Patient.identifier│
           │    personAddress     → Patient.address   │
           └────────┬─────────────────────────────────┘
                    │
                    ▼
           HAPI serializes FHIR Patient → JSON
                    │
                    ▼
       HTTP 200  { "resourceType": "Patient", "id": "3a7c...",
                   "name": [{"family":"Smith","given":["John"]}],
                   "gender": "male", "birthDate": "1985-03-15", ... }
```

---

### 5. Write Path Design (POST/PUT) — Detailed

This is the most critical path — it replaces the entire async sync chain:

```/dev/null/write-path.txt#L1-80
Client: POST /fhir/facade/Patient
        { "resourceType":"Patient", "name":[{"family":"Diallo","given":["Aminata"]}],
          "gender":"female", "birthDate":"1990-07-22",
          "identifier":[{"system":"http://openelis-global.org/pat_nationalId","value":"MG123456"}] }
                    │
                    ▼
       FhirRestfulServer  identifies:
       resourceType = Patient
       operation   = CREATE  (POST)
                    │
                    ▼
       PatientProvider.create(Patient fhirPatient)
                    │
           ┌────────┴──────────────────────────────────┐
           │  UUID ASSIGNMENT STEP                     │
           │                                           │
           │  if (fhirPatient.getId() == null)         │
           │      fhirPatient.setId(                   │
           │          UUID.randomUUID().toString())     │
           │                                           │
           │  This UUID becomes fhir_uuid in clinlims  │
           │  AND the FHIR resource ID — they are THE  │
           │  SAME value, in the same DB, no sync needed│
           └────────┬──────────────────────────────────┘
                    │
                    ▼
           ┌────────┴──────────────────────────────────┐
           │  TRANSLATION STEP (WRITE PATH)            │
           │                                           │
           │  Parse FHIR → OE domain objects           │
           │                                           │
           │  Person oePersont = new Person()          │
           │  oePersont.setLastName("Diallo")          │
           │  oePersont.setFirstName("Aminata")        │
           │                                           │
           │  Patient oePatient = new Patient()        │
           │  oePatient.setFhirUuid(UUID from FHIR id) │
           │  oePatient.setGender("F")                 │
           │  oePatient.setBirthDate(1990-07-22)       │
           │                                           │
           │  PatientIdentity nationalId = ...         │
           │  nationalId.setValue("MG123456")          │
           └────────┬──────────────────────────────────┘
                    │
                    ▼
           ┌────────┴──────────────────────────────────┐
           │  PERSISTENCE STEP  (@Transactional)       │
           │                                           │
           │  personService.save(oePerson)             │
           │    → INSERT INTO clinlims.person (...)    │
           │                                           │
           │  oePatient.setPerson(savedPerson)         │
           │  patientService.save(oePatient)           │
           │    → INSERT INTO clinlims.patient         │
           │       (fhir_uuid = '3a7c-f482-...')  ←───┼─ fhir_uuid written HERE
           │                                           │
           │  patientIdentityService.save(nationalId)  │
           │    → INSERT INTO clinlims.patient_identity│
           │                                           │
           │  ONE transaction. If it fails, nothing    │
           │  is written. No second server to sync.    │
           └────────┬──────────────────────────────────┘
                    │
                    ▼
           Read back saved patient, transform to FHIR
                    │
                    ▼
       HTTP 201  Location: /fhir/facade/Patient/3a7c-f482-...
                 { "resourceType":"Patient", "id":"3a7c-f482-...", ... }
```

---

### 6. The Complete Resource Provider Design Catalogue

This table shows the full design for every provider that must be built, grounding each one in actual existing code:

```/dev/null/provider-catalogue.txt#L1-80
╔══════════╦════════════════════╦═══════════════════════════════╦══════════════════════╗
║  FHIR    ║  OE Domain         ║  OE Service(s)                ║  fhir_uuid column    ║
║  Resource║  Object(s)         ║  (already exist)              ║  (already in DB)     ║
╠══════════╬════════════════════╬═══════════════════════════════╬══════════════════════╣
║ Patient  ║ Patient            ║ PatientService                ║ clinlims.patient     ║
║          ║ Person             ║   .getMatch("fhirUuid", ...)  ║   .fhir_uuid         ║
║          ║ PatientIdentity    ║   .persistPatientData(...)    ║                      ║
╠══════════╬════════════════════╬═══════════════════════════════╬══════════════════════╣
║ Task     ║ Sample             ║ SampleService                 ║ clinlims.sample      ║
║          ║                    ║   .getMatch("fhirUuid", ...)  ║   .fhir_uuid         ║
║          ║                    ║   .getSampleByAccessionNumber ║                      ║
║          ║                    ║   (inbound: DBOrderPersister) ║                      ║
╠══════════╬════════════════════╬═══════════════════════════════╬══════════════════════╣
║ Service  ║ Analysis           ║ AnalysisService               ║ clinlims.analysis    ║
║ Request  ║                    ║   .getMatch("fhirUuid", ...)  ║   .fhir_uuid         ║
║          ║                    ║   .updateAnalysises(...)      ║                      ║
╠══════════╬════════════════════╬═══════════════════════════════╬══════════════════════╣
║ Specimen ║ SampleItem         ║ SampleItemService             ║ clinlims.sample_item ║
║          ║                    ║   .getMatch("fhirUuid", ...)  ║   .fhir_uuid         ║
╠══════════╬════════════════════╬═══════════════════════════════╬══════════════════════╣
║ Observ-  ║ Result             ║ ResultService                 ║ clinlims.result      ║
║ ation    ║                    ║   .getMatch("fhirUuid", ...)  ║   .fhir_uuid         ║
╠══════════╬════════════════════╬═══════════════════════════════╬══════════════════════╣
║ Diagnost ║ Analysis           ║ AnalysisService               ║ clinlims.analysis    ║
║ icReport ║ (finalized)        ║   .getMatch("fhirUuid", ...)  ║   .fhir_uuid         ║
║          ║ + Results          ║ ResultService                 ║                      ║
╠══════════╬════════════════════╬═══════════════════════════════╬══════════════════════╣
║ Practit- ║ Provider           ║ ProviderService               ║ clinlims.provider    ║
║ ioner    ║ Person             ║   .getProviderByFhirId(...)   ║   .fhir_uuid         ║
║          ║                    ║   ← ALREADY BUILT             ║                      ║
╠══════════╬════════════════════╬═══════════════════════════════╬══════════════════════╣
║ Organ-   ║ Organization       ║ OrganizationService           ║ clinlims.organization║
║ ization  ║                    ║   .getMatch("fhirUuid", ...)  ║   .fhir_uuid         ║
╚══════════╩════════════════════╩═══════════════════════════════╩══════════════════════╝
```

---

### 7. Transaction Boundary Design

This is the most important correctness property of the new architecture. The old system had two separate, uncoordinated transactions. The new system has one:

```/dev/null/transaction-design.txt#L1-55
OLD ARCHITECTURE — TWO TRANSACTIONS (CAN DESYNC):
─────────────────────────────────────────────────
┌─ Transaction 1 (Spring @Transactional) ──────────────┐
│  SamplePatientEntryService.persistData()             │
│    personService.save(person)      → clinlims.person │
│    patientService.save(patient)    → clinlims.patient│
│    sampleService.insert(sample)    → clinlims.sample │
│    analysisService.insert(analysis)→ clinlims.analysis│
│  COMMIT                                              │
└──────────────────────────────────────────────────────┘
         │
         │  ApplicationEvent fired  (async, different thread)
         ▼
┌─ Transaction 2 (HTTP call to HAPI) ──────────────────┐
│  FhirTransformService.transformPersistOrderEntry()   │
│    → FhirPersistanceService                          │
│      → localFhirClient.transaction()                 │
│        → HTTP POST to fhir.openelis.org:8080         │
│          → HAPI JPA writes Patient, Task, etc.       │
│  CAN FAIL → data in T1 not in T2  ← DESYNC           │
└──────────────────────────────────────────────────────┘


NEW ARCHITECTURE — ONE TRANSACTION (CANNOT DESYNC):
────────────────────────────────────────────────────
Client: POST /fhir/facade/Patient  { FHIR Patient JSON }
                    │
┌─ Single Transaction (@Transactional on Provider) ────┐
│                                                       │
│  PatientProvider.create(fhirPatient)                 │
│    │                                                  │
│    ├─ personService.save(person)                     │
│    │    → INSERT clinlims.person                     │
│    │                                                  │
│    ├─ patientService.save(patient)                   │
│    │    → INSERT clinlims.patient (fhir_uuid = X)    │
│    │                                                  │
│    └─ patientIdentityService.save(...)               │
│         → INSERT clinlims.patient_identity           │
│                                                       │
│  COMMIT  — or ROLLBACK ALL if anything fails         │
│                                                       │
│  Response: 201 { fhir_uuid X is now the FHIR ID }   │
└───────────────────────────────────────────────────────┘

Postgres IS the FHIR store.
clinlims.patient.fhir_uuid IS the Patient FHIR ID.
There is no second database to sync.
```

---

### 8. The FhirTransformService Role Redesign

`FhirTransformService` currently serves both read and write directions. In the new design its role is **cleanly split**:

```/dev/null/transform-service-design.txt#L1-55
CURRENT ROLE  (conflated):
────────────────────────────────────────────────────────────
FhirTransformService
  transformToFhirPatient(Patient oePatient)   → FHIR Patient    [read path]
  transformToFhirOrganization(Organization)   → FHIR Org        [read path]
  transformToTask(Sample)                     → FHIR Task       [read path]
  transformToServiceRequest(Analysis)         → FHIR ServiceReq [read path]
  transformToSpecimen(SampleItem)             → FHIR Specimen   [read path]
  transformResultToObservation(Result)        → FHIR Observation[read path]
  transformResultToDiagnosticReport(Analysis) → FHIR DiagReport [read path]

  transformToProvider(Practitioner)           → OE Provider     [write path]
  transformToOrganization(FHIR Org)           → OE Organization [write path]
  transformToOpenElisPatientSearchResults()   → OE Patient data [write path]

  transformPersistPatient()        ← COMBINES translate + persist [DELETE]
  transformPersistOrderEntry()     ← COMBINES translate + persist [DELETE]
  transformPersistResultsEntry()   ← COMBINES translate + persist [DELETE]


NEW ROLE  (cleanly separated):
────────────────────────────────────────────────────────────
FhirTransformService  (READ-PATH ONLY — pure translation, no side effects)
  FHIR Resource = fhirTransformService.transformXxx(oeObject)
  ├─ transformToFhirPatient(Patient)          → used by PatientProvider @Read/@Search
  ├─ transformToTask(Sample)                  → used by TaskProvider @Read/@Search
  ├─ transformToServiceRequest(Analysis)      → used by ServiceRequestProvider @Read/@Search
  ├─ transformToSpecimen(SampleItem)          → used by SpecimenProvider @Read/@Search
  ├─ transformResultToObservation(Result)     → used by ObservationProvider @Read/@Search
  ├─ transformResultToDiagnosticReport(Anal.) → used by DiagReportProvider @Read/@Search
  └─ transformToFhirOrganization(Org)         → used by OrganizationProvider @Read/@Search

IResourceProvider.create()/update() methods  (WRITE-PATH — each provider owns its write logic)
  ├─ PatientProvider.create()     → parse FHIR Patient  → patientService.save()
  ├─ TaskProvider.create()        → parse FHIR Task     → TaskWorker/DBOrderPersister
  ├─ ServiceRequestProvider       → parse FHIR SR       → analysisService.save()
  └─ ...etc
```

---

### 9. The Routing Gateway Design — `InternalFhirApi` Final State

This is the transition design. It shows exactly what `InternalFhirApi` looks like when the facade is complete:

```/dev/null/gateway-design.txt#L1-55
InternalFhirApi  (@RestController  /fhir/**)
─────────────────────────────────────────────────────────────────────────────
                           │
              ┌────────────┼────────────────┐
              │            │                │
         GET /fhir/**   POST /fhir/**   PUT /fhir/**
              │            │                │
              ▼            ▼                ▼
         forwardToFacade() ──────────────────────► /fhir/facade/**
              │                                          │
              ▼                                          ▼
    FhirRestfulServer (HAPI Plain Server)   FhirRestfulServer (HAPI Plain Server)
              │                                          │
         @Read  @Search                           @Create  @Update
              │                                          │
              ▼                                          ▼
       OE Service Layer (read)               OE Service Layer (write)
              │                                          │
              ▼                                          ▼
    clinlims PostgreSQL (SELECT)          clinlims PostgreSQL (INSERT/UPDATE)


CURRENT STATE (transitional — GET still goes to HAPI external):
─────────────────────────────────────────────────────────────────
  GET  → forwardGetRequest() → HTTP GET to fhir.openelis.org (old HAPI)
  POST → forwardToFacade()   → /fhir/facade (new)
  PUT  → forwardToFacade()   → /fhir/facade (new)

TARGET STATE (facade complete — HAPI external container no longer needed):
─────────────────────────────────────────────────────────────────
  GET  → forwardToFacade() → /fhir/facade (new, @Read + @Search implemented)
  POST → forwardToFacade() → /fhir/facade (new)
  PUT  → forwardToFacade() → /fhir/facade (new)
```

---

### 10. The Search Design — Bundle Construction

FHIR search results return a `Bundle`. This is a non-trivial design point because each search goes to a different OE service query:

```/dev/null/search-design.txt#L1-65
Client: GET /fhir/facade/Patient?family=Diallo&birthdate=ge1985

              FhirRestfulServer routes to:
              PatientProvider.search(
                  @OptionalParam(name=Patient.SP_FAMILY) StringParam family,
                  @OptionalParam(name=Patient.SP_BIRTHDATE) DateParam birthdate
              )
                    │
                    ▼
          ┌─────────────────────────────────────────────┐
          │  QUERY STEP                                 │
          │                                             │
          │  Uses existing OE DAO capabilities:         │
          │                                             │
          │  patientService.getAllLike("person.lastName"│
          │    "Diallo")                                │
          │  → HQL: FROM Patient p JOIN p.person per   │
          │    WHERE per.lastName LIKE '%Diallo%'       │
          │  → Returns: List<Patient> (OE domain)       │
          │                                             │
          │  Then filter by birthdate client-side OR    │
          │  add to DAO query  (DAO extension point)    │
          └─────────────────────────────────────────────┘
                    │
                    ▼
          ┌─────────────────────────────────────────────┐
          │  BUNDLE CONSTRUCTION                        │
          │                                             │
          │  List<IBaseResource> results = new ArrayList│
          │  for (Patient oePatient : oePatients) {    │
          │    org.hl7.fhir.r4.model.Patient fhirPat   │
          │      = fhirTransformService                 │
          │          .transformToFhirPatient(           │
          │               oePatient.getId())            │
          │    results.add(fhirPat)                     │
          │  }                                          │
          │  return results  ← HAPI wraps in Bundle    │
          └─────────────────────────────────────────────┘
                    │
                    ▼
       HTTP 200  {
         "resourceType": "Bundle",
         "type": "searchset",
         "total": 2,
         "entry": [
           { "resource": { "resourceType":"Patient", "id":"uuid1", "name":[...] } },
           { "resource": { "resourceType":"Patient", "id":"uuid2", "name":[...] } }
         ]
       }
```

---

### 11. What Gets Removed vs. What Gets Kept — Precise Design Decision Map

╠══════════════════════════════════╬══════════╬════════════════════════════════╣
║ FhirTransformService (read       ║  KEEP    ║ Core read-path translation.    ║
║  methods: transformToFhirXxx)    ║          ║ Used by every @Read/@Search    ║
╠══════════════════════════════════╬══════════╬════════════════════════════════╣
║ FhirTransformService (write      ║  DELETE  ║ transformPersistXxx methods    ║
║  methods: transformPersistXxx)   ║          ║ replaced by Provider.create()  ║
╠══════════════════════════════════╬══════════╬════════════════════════════════╣
║ FhirPersistanceService           ║  DELETE  ║ Entire class. Its job was      ║
║ FhirPersistanceServiceImpl       ║          ║ writing to HAPI. Facade writes ║
║                                  ║          ║ directly to OE services.       ║
╠══════════════════════════════════╬══════════╬════════════════════════════════╣
║ FhirApiWorkflowService           ║  DELETE  ║ Scheduled poll replaced by     ║
║ FhirApiWorkFlowServiceImpl       ║          ║ direct POST to facade          ║
╠══════════════════════════════════╬══════════╬════════════════════════════════╣
║ SampleFhirTransformEventListener ║  DELETE  ║ Async post-save sync removed.  ║
║                                  ║          ║ Facade is the write path now.  ║
╠══════════════════════════════════╬══════════╬════════════════════════════════╣
║ FhirTransformationController     ║  DELETE  ║ Boot-time reconciliation scan  ║
║  (transformOEObjectsOnBoot)      ║          ║ not needed — no drift possible ║
╠══════════════════════════════════╬══════════╬════════════════════════════════╣
║ RegisterFhirHooksTask            ║  DELETE  ║ HAPI subscriptions on external ║
║                                  ║          ║ server no longer needed        ║
╠══════════════════════════════════╬══════════╬════════════════════════════════╣
║ FhirExportController             ║  DELETE  ║ DataExportService push to HAPI ║
║ DataExportService                ║          ║ not needed — facade IS the     ║
║                                  ║          ║ authoritative endpoint         ║
╠══════════════════════════════════╬══════════╬════════════════════════════════╣
║ FhirConfig (localFhirStorePath,  ║  SHRINK  ║ remoteStorePaths for outbound  ║
║  remoteStorePaths, username,     ║          ║ referrals kept. localFhirStore ║
║  password)                       ║          ║ Path removed — facade IS local ║
╠══════════════════════════════════╬══════════╬════════════════════════════════╣
║ FhirUtil.getFhirClient()         ║  SHRINK  ║ Only needed for outbound FHIR  ║
║                                  ║          ║ referral push to remote labs   ║
╠══════════════════════════════════╬══════════╬════════════════════════════════╣
║ TaskWorker                       ║  KEEP    ║ Inbound order logic reused by  ║
║ TaskInterpreterImpl              ║  KEEP    ║ TaskProvider.create()          ║
║ DBOrderPersister                 ║  KEEP    ║ Writes order to clinlims       ║
║ DBOrderExistanceChecker          ║  KEEP    ║ Duplicate detection            ║
╠══════════════════════════════════╬══════════╬════════════════════════════════╣
║ PractitionerProvider             ║  KEEP    ║ Already built — proof of       ║
║                                  ║  +FIX    ║ concept. Fix 2 known bugs.     ║
╠══════════════════════════════════╬══════════╬════════════════════════════════╣
║ fhir_uuid columns in clinlims    ║  KEEP    ║ These ARE the FHIR IDs. They   ║
║  (all 8 tables)                  ║          ║ stay exactly as-is.            ║
╠══════════════════════════════════╬══════════╬════════════════════════════════╣
║ fhir.openelis.org Docker         ║  OPTIONAL║ Can be kept for outbound FHIR  ║
║  (HAPI JPA container)            ║          ║ subscription notifications to  ║
║                                  ║          ║ external systems only.         ║
╚══════════════════════════════════╩══════════╩════════════════════════════════╝
```

---

### 12. The ID Resolution Design — How `fhir_uuid` Becomes the FHIR ID

This is the foundational technical design decision that makes everything work. It must be designed precisely:

```/dev/null/id-resolution.txt#L1-70
                    ID RESOLUTION CONTRACT
    ─────────────────────────────────────────────────────────────

    For every OE domain object that maps to a FHIR resource:

        clinlims.TABLE.fhir_uuid  ←→  FHIR Resource.id

    They are the SAME UUID. Stored ONCE. In ONE database.


    CASE 1: OE creates the object first (Scenario A workflow)
    ──────────────────────────────────────────────────────────
    AnalysisServiceImpl.insert(Analysis analysis) {
        if (analysis.getFhirUuid() == null) {
            analysis.setFhirUuid(UUID.randomUUID()); ← assigned at insert time
        }
        ...
    }

    → The fhir_uuid is generated BEFORE Hibernate writes the row.
    → It is committed to clinlims.analysis.fhir_uuid atomically.
    → ServiceRequestProvider.read(IdType id):
        analysisService.getMatch("fhirUuid", UUID.fromString(id.getIdPart()))
    → Works immediately. No sync needed. No boot scan needed.


    CASE 2: External system creates the object first (Scenario B workflow)
    ───────────────────────────────────────────────────────────────────────
    External system:  POST /fhir/facade/Task
        { "resourceType":"Task", "id":"ext-provided-uuid", ...order details... }

    TaskProvider.create(Task fhirTask) {
        // if external system provided an ID, honour it
        UUID fhirId = UUID.fromString(fhirTask.getIdElement().getIdPart());

        // TaskInterpreter parses the Task → MessagePatient + labOrderNumber
        // DBOrderPersister.persist(messagePatient, eOrder)
        //   → creates Sample in clinlims
        //   → sample.setFhirUuid(fhirId)  ← stores external-provided UUID
        //   → INSERT INTO clinlims.sample (fhir_uuid = 'ext-provided-uuid')
    }

    → The external UUID is now the sample's fhir_uuid.
    → GET /fhir/facade/Task/ext-provided-uuid works immediately.
    → No polling. No HAPI involved.


    CASE 3: UUID missing on legacy data (migration concern)
    ───────────────────────────────────────────────────────
    Some existing clinlims rows have NULL fhir_uuid
    (data pre-dating the fhir_uuid migration in Liquibase 2.3.x.x)

    Handled by: PatientService.getAllMissingFhirUuid()
                SampleService.getAllMissingFhirUuid()

    A one-time Liquibase migration changeset generates and backfills
    UUIDs for all NULL rows at deployment time.
    FhirTransformationController.transformOEObjectsOnBoot() is then
    no longer needed and is removed.
```

---

### 13. The `TaskProvider` Design — The Most Complex Case

Task deserves its own detailed design because inbound task creation (Scenario B) uses `TaskWorker`, which is a multi-step process:

```/dev/null/task-provider-design.txt#L1-90
TaskProvider  (IResourceProvider for Task ↔ Sample)
─────────────────────────────────────────────────────────────────────────────

  getResourceType() → Task.class


  @Read
  ──────
  read(IdType theId):
    Sample sample = sampleService.getMatch("fhirUuid",
                        UUID.fromString(theId.getIdPart()))
    return fhirTransformService.transformToTask(sample)
    ↓
    transformToTask(Sample) already built in FhirTransformServiceImpl L621-669
    produces Task with:
      task.setId(sample.fhirUuid)
      task.setStatus(map from sample.statusId)
      task.setPriority(map from sample.priority)
      task.setFor(Patient ref via patient.fhirUuid)
      task.addBasedOn(ServiceRequest refs via analysis.fhirUuid[])
      task.addOutput(DiagnosticReport refs if finalized)


  @Search
  ──────
  search(@OptionalParam(name=Task.SP_STATUS) TokenParam status,
         @OptionalParam(name=Task.SP_OWNER)  ReferenceParam owner):

    Map searchParams = new HashMap()
    if (status != null)
        statusId = statusService.getStatusID(mapFhirStatusToOE(status))
        searchParams.put("statusId", statusId)
    List<Sample> samples = sampleService.getAllMatching(searchParams)
    return samples.stream()
        .map(s -> fhirTransformService.transformToTask(s))
        .collect(toList())


  @Create  (inbound order — Scenario B)
  ──────────────────────────────────────
  create(Task fhirTask):
    ┌───────────────────────────────────────────────────────────────┐
    │  STEP 1: Get the linked ServiceRequest(s) from the Bundle or  │
    │          fetch from the remote FHIR server if referenced      │
    │                                                               │
    │  List<ServiceRequest> serviceRequests =                       │
    │      extractServiceRequests(fhirTask)                         │
    └───────────────────────────────────────────────────────────────┘
                    │
                    ▼
    ┌───────────────────────────────────────────────────────────────┐
    │  STEP 2: Get the Patient resource from Task.for reference     │
    │                                                               │
    │  Patient fhirPatient = extractPatient(fhirTask)               │
    └───────────────────────────────────────────────────────────────┘
                    │
                    ▼
    ┌───────────────────────────────────────────────────────────────┐
    │  STEP 3: For each ServiceRequest, run TaskWorker              │
    │          (this is the EXACT same logic FhirApiWorkflow used,  │
    │           but now called directly, no polling needed)         │
    │                                                               │
    │  for (ServiceRequest sr : serviceRequests) {                  │
    │      TaskWorker worker = new TaskWorker(                      │
    │          fhirTask,                                            │
    │          fhirContext.newJsonParser().encode(fhirTask),        │
    │          sr,                                                   │
    │          fhirPatient                                          │
    │      )                                                        │
    │      worker.setInterpreter(taskInterpreter)                   │
    │      worker.setExistanceChecker(dbOrderExistanceChecker)      │
    │      worker.setPersister(dbOrderPersister)                    │
    │      TaskResult result = worker.handleOrderRequest()          │
    │                                                               │
    │      // handleOrderRequest() calls DBOrderPersister.persist() │
    │      // → INSERT INTO clinlims.sample  (fhir_uuid = task.id)  │
    │      // → INSERT INTO clinlims.electronic_order               │
    │  }                                                            │
    └───────────────────────────────────────────────────────────────┘
                    │
                    ▼
    ┌───────────────────────────────────────────────────────────────┐
    │  STEP 4: Set Task status on newly created local Task          │
    │          and return                                           │
    │                                                               │
    │  Sample created = sampleService.getSampleByReferringId(       │
    │                       extractOrderNumber(fhirTask))           │
    │  Task responseTask = fhirTransformService.transformToTask(    │
    │                          created)                             │
    │  return new MethodOutcome().setResource(responseTask)         │
    │                            .setCreated(true)                  │
    └───────────────────────────────────────────────────────────────┘


  @Update  (status update — e.g. lab accepts/rejects referral)
  ─────────────────────────────────────────────────────────────
  update(IdType theId, Task fhirTask):
    Sample sample = sampleService.getMatch("fhirUuid", UUID.fromString(theId))
    TaskStatus newStatus = fhirTask.getStatus()
    sample.setStatusId(mapFhirTaskStatusToOE(newStatus))
    sampleService.save(sample)
    return new MethodOutcome().setResource(
        fhirTransformService.transformToTask(sample))
```

---

### 14. The `DiagnosticReportProvider` Design — The Read-Only Case

`DiagnosticReport` is a composed resource — it assembles data from multiple OE tables. It is fundamentally **read-only** from the facade perspective (results are entered through the OE UI or `ObservationProvider`):

```/dev/null/diagreport-design.txt#L1-55
DiagnosticReportProvider  (IResourceProvider for DiagnosticReport ↔ Analysis+Result)
──────────────────────────────────────────────────────────────────────────────────────

  getResourceType() → DiagnosticReport.class


  @Read
  ──────
  read(IdType theId):
    ┌──────────────────────────────────────────────────┐
    │  Analysis is the DiagnosticReport.               │
    │  analysis.fhir_uuid = DiagnosticReport.id        │
    │                                                  │
    │  Analysis analysis = analysisService.getMatch(   │
    │      "fhirUuid",                                 │
    │       UUID.fromString(theId.getIdPart()))        │
    │  .orElseThrow(() -> ResourceNotFoundException)   │
    └──────────────────────────────────────────────────┘
                    │
    ┌───────────────▼──────────────────────────────────┐
    │  Only return if finalized — DiagnosticReport     │
    │  is only meaningful when Analysis is FINALIZED   │
    │                                                  │
    │  if (!statusService.matches(                     │
    │           analysis.getStatusId(),                │
    │           AnalysisStatus.Finalized)) {           │
    │      throw new ResourceNotFoundException(theId)  │
    │  }                                               │
    └──────────────────────────────────────────────────┘
                    │
    ┌───────────────▼──────────────────────────────────┐
    │  Transform — already built                       │
    │                                                  │
    │  return fhirTransformService                     │
    │      .transformResultToDiagnosticReport(analysis)│
    │                                                  │
    │  Assembles:                                      │
    │   DiagnosticReport.id = analysis.fhirUuid        │
    │   DiagnosticReport.status = FINAL                │
    │   DiagnosticReport.subject = Patient/uuid        │
    │   DiagnosticReport.basedOn = ServiceRequest/uuid │
    │   DiagnosticReport.result[] = Observation/uuid[] │
    │   DiagnosticReport.code = LOINC from test        │
    └──────────────────────────────────────────────────┘


  @Search
  ──────
  search(@OptionalParam(name=DiagnosticReport.SP_PATIENT) ReferenceParam patient,
         @OptionalParam(name=DiagnosticReport.SP_STATUS)  TokenParam status):

    List<Integer> finalizedStatusIds = List.of(
        Integer.parseInt(statusService.getStatusID(AnalysisStatus.Finalized)))

    if (patient != null) {
        // get patient from fhir_uuid
        Patient oePatient = patientService.getMatch("fhirUuid",
            UUID.fromString(patient.getIdPart()))
        // get all samples for patient
        List<Sample> samples = sampleService.getSamplesForPatient(oePatient.getId())
        // get all finalized analyses
        return samples.stream()
            .flatMap(s -> analysisService.getAnalysesBySampleId(s.getId()).stream())
            .filter(a -> statusService.matches(a.getStatusId(), AnalysisStatus.Finalized))
            .map(a -> fhirTransformService.transformResultToDiagnosticReport(a))
            .collect(toList())
    }
```

---

### 15. The Two Known Bugs in `PractitionerProvider` — Fix Design

These must be fixed before `PractitionerProvider` is used as the template for all other providers:

```/dev/null/practitioner-provider-fixes.txt#L1-55
BUG 1: Manual instantiation of Spring bean
───────────────────────────────────────────
CURRENT (wrong):
  FhirTransformServiceImpl transForm = new FhirTransformServiceImpl();
  transForm.addHumanNameToPerson(practitioner.getNameFirstRep(), existingPerson);
  transForm.addTelecomToPerson(practitioner.getTelecom(), existingPerson);

  Problem: FhirTransformServiceImpl has @Autowired dependencies.
  Manually instantiated object has NULL services — will NullPointerException
  the moment any injected field is accessed internally.

FIX: Inject the interface (not the implementation) and call through it.
  Add to PractitionerProvider:
    @Autowired
    private FhirTransformServiceImpl fhirTransformServiceImpl;
    // (or add addHumanNameToPerson/addTelecomToPerson to the interface)

  CORRECTED:
    fhirTransformServiceImpl.addHumanNameToPerson(
        practitioner.getNameFirstRep(), existingPerson)
    fhirTransformServiceImpl.addTelecomToPerson(
        practitioner.getTelecom(), existingPerson)


BUG 2: Residual HAPI sync call in write path
─────────────────────────────────────────────
CURRENT (wrong for new architecture):
  try {
      fhirPersistenceService.updateFhirResourceInFhirStore(practitionerToSave);
  } catch (Exception syncEx) {
      LogEvent.logError(..., "FHIR store sync failed (continuing anyway)");
  }

  Problem: This still calls out to the old HAPI JPA server over HTTP.
  In the new architecture, clinlims IS the FHIR store.
  This call is redundant noise and a latency hit.

FIX: Remove entirely from create() and update().
  The response resource is already constructed from the saved OE object.
  No sync needed.


CORRECT TEMPLATE for all future Providers:
──────────────────────────────────────────
  @Create
  @Transactional
  public MethodOutcome create(@ResourceParam T fhirResource,
                              HttpServletRequest request) {
      // 1. Assign fhir_uuid if missing
      if (fhirResource.getIdElement().getIdPart() == null)
          fhirResource.setId(UUID.randomUUID().toString())

      // 2. Translate FHIR → OE domain (pure parsing, no DB calls)
      OEDomainObject oeObject = translate(fhirResource)
      oeObject.setSysUserId(ControllerUtills.getSysUserId(request))

      // 3. Persist via OE service (ONE transaction, direct to clinlims)
      OEDomainObject saved = oeService.save(oeObject)

      // 4. Translate back to FHIR for response (no extra DB reads needed)
      T responseResource = fhirTransformService.transformToFhir(saved)

      // 5. Return — NO sync call, NO try/catch around a second DB
      return new MethodOutcome()
          .setId(responseResource.getIdElement())
          .setResource(responseResource)
          .setCreated(true)
  }
```

---

### 16. The Complete Package Structure Design

```/dev/null/package-structure.txt#L1-60
src/main/java/org/openelisglobal/
│
├── fhir/
│   ├── servlets/
│   │   └── FhirRestfulServer.java          ← KEEP (no changes needed)
│   │
│   ├── providers/                           ← THE NEW LAYER
│   │   ├── PatientProvider.java            ← BUILD
│   │   ├── TaskProvider.java               ← BUILD
│   │   ├── ServiceRequestProvider.java     ← BUILD
│   │   ├── SpecimenProvider.java           ← BUILD
│   │   ├── ObservationProvider.java        ← BUILD
│   │   ├── DiagnosticReportProvider.java   ← BUILD
│   │   ├── OrganizationProvider.java       ← BUILD
│   │   └── PractitionerProvider.java       ← FIX (already exists)
│   │
│   └── actions/
│       └── FhirActionController.java       ← KEEP
│
├── dataexchange/fhir/
│   ├── FhirConfig.java                     ← SHRINK (remove localFhirStorePath)
│   ├── FhirUtil.java                       ← SHRINK (keep only for outbound)
│   │
│   ├── service/
│   │   ├── FhirTransformService.java       ← KEEP interface (remove persist methods)
│   │   ├── FhirTransformServiceImpl.java   ← KEEP read-path transforms (remove transformPersistXxx)
│   │   ├── FhirPersistanceService.java     ← DELETE
│   │   ├── FhirPersistanceServiceImpl.java ← DELETE
│   │   ├── FhirApiWorkflowService.java     ← DELETE
│   │   ├── FhirApiWorkFlowServiceImpl.java ← DELETE
│   │   ├── TaskInterpreter.java            ← KEEP (reused by TaskProvider)
│   │   ├── TaskInterpreterImpl.java        ← KEEP
│   │   ├── TaskWorker.java                 ← KEEP
│   │   ├── FhirFacilityOrganizationService.java    ← KEEP
│   │   └── FhirFacilityOrganizationServiceImpl.java← KEEP
│   │
│   ├── controller/
│   │   ├── InternalFhirApi.java            ← MODIFY (GET also goes to facade)
│   │   ├── FhirQueryRestController.java    ← DELETE (superseded by facade)
│   │   └── FhirExportController.java       ← DELETE
│   │
│   └── exception/
│       ├── FhirGeneralException.java       ← KEEP
│       ├── FhirLocalPersistingException.java ← KEEP (reused by providers)
│       ├── FhirPersistanceException.java   ← KEEP
│       └── FhirTransformationException.java← KEEP
│
├── sample/event/
│   ├── SamplePatientUpdateDataCreatedEvent.java        ← KEEP (Odoo uses it)
│   ├── listener/
│   │   ├── SampleFhirTransformEventListener.java       ← DELETE
│   │   └── SamplePatientUpdateDataCreatedEventListener ← KEEP (Odoo)
│
├── fhir/transormation/controller/
│   └── FhirTransformationController.java   ← DELETE
│
└── config/task/
    └── RegisterFhirHooksTask.java          ← DELETE
```

---

### 17. The Migration Strategy Design — Zero Downtime Phasing

This is how you move from current to target without breaking live deployments:

```/dev/null/migration-phases.txt#L1-75
PHASE 1 — Foundation (no behavior change, pure additions)
──────────────────────────────────────────────────────────
  ✓ Fix PractitionerProvider bugs (2 fixes described above)
  ✓ Add @Read to PractitionerProvider
    (GET /fhir/facade/Practitioner/{uuid} → providerService.getProviderByFhirId())
  ✓ Add @Search to PractitionerProvider
  ✓ Write Liquibase changeset: backfill NULL fhir_uuid on all 8 tables
    (guarantees every row has a FHIR ID before providers go live)
  ✓ InternalFhirApi GET still points to old HAPI for non-Practitioner
  ✓ All existing tests pass. Nothing deleted yet.


PHASE 2 — Patient Provider (highest value, widest usage)
──────────────────────────────────────────────────────────
  ✓ Build PatientProvider (@Create, @Read, @Update, @Search)
  ✓ Write unit test (same pattern as PractitionerFacadeTest)
  ✓ InternalFhirApi: redirect GET /fhir/Patient/** → forwardToFacade
  ✓ SampleFhirTransformEventListener: remove patient sync call
    (patient now always in clinlims via PatientProvider or OE UI)
  ✓ FhirTransformationController: remove patient batch loop
    (no longer needed — all patients have fhir_uuid, no drift)


PHASE 3 — Specimen + ServiceRequest + Observation (lab core)
──────────────────────────────────────────────────────────────
  ✓ Build SpecimenProvider (@Create, @Read, @Search)
  ✓ Build ServiceRequestProvider (@Create, @Read, @Update, @Search)
  ✓ Build ObservationProvider (@Create, @Read, @Search)
  ✓ InternalFhirApi: redirect GETs for these types → forwardToFacade
  ✓ Remove corresponding sync calls from SampleFhirTransformEventListener


PHASE 4 — Task + DiagnosticReport (workflow completion)
──────────────────────────────────────────────────────────
  ✓ Build TaskProvider (@Create, @Read, @Update, @Search)
  ✓ Build DiagnosticReportProvider (@Read, @Search — read-only)
  ✓ FhirApiWorkflowService.pollForRemoteTasks() DELETED
    (external systems now POST directly to /fhir/facade/Task)
  ✓ InternalFhirApi: all GETs now → forwardToFacade
  ✓ FhirTransformationController DELETED
  ✓ SampleFhirTransformEventListener DELETED


PHASE 5 — Organization + Cleanup
──────────────────────────────────────────────────────────
  ✓ Build OrganizationProvider (@Create, @Read, @Update, @Search)
  ✓ RegisterFhirHooksTask DELETED
  ✓ FhirExportController DELETED
  ✓ FhirPersistanceService + FhirPersistanceServiceImpl DELETED
  ✓ FhirApiWorkflowService interface + impl DELETED
  ✓ FhirConfig.localFhirStorePath removed
  ✓ docker-compose.yml: fhir.openelis.org container marked optional
  ✓ FhirTransformService: transformPersistXxx methods removed from interface


RESULT — Target state fully achieved:
──────────────────────────────────────
  One database. One transaction per write.
  FHIR read = query clinlims + transform.
  FHIR write = parse FHIR + save to clinlims.
  No drift. No polling. No boot scan. No second container required.
```

---

### 18. The Design Invariants — Rules Every Provider Must Follow

These are the non-negotiable design rules that every provider implementation must respect, derived from the constitutional principles and the architecture:

```/dev/null/design-invariants.txt#L1-40
INVARIANT 1 — FHIR ID = fhir_uuid column
  Every provider @Read and @Search MUST look up OE objects
  using getMatch("fhirUuid", UUID.fromString(theId.getIdPart())).
  Never use OE's internal integer/string PK as the FHIR ID.

INVARIANT 2 — One transaction per write
  Every @Create and @Update MUST be annotated @Transactional.
  The transaction boundary is the provider method itself.
  No async. No event publishing for FHIR sync.

INVARIANT 3 — No HTTP calls in the write path
  Providers MUST NOT call fhirPersistanceService.updateFhirResourceInFhirStore()
  or any HTTP client during @Create / @Update.
  clinlims IS the FHIR store.

INVARIANT 4 — Layer law: Providers call Services, never DAOs
  Providers are effectively at the Controller layer.
  They MUST call OE Service interfaces (PatientService, SampleService, etc.)
  Never inject or call DAO classes directly.
  This matches the existing 5-layer architecture rule.

INVARIANT 5 — fhir_uuid assignment is permanent
  Once a fhir_uuid is assigned to an OE object and returned
  as a FHIR resource ID, it MUST NOT change.
  Providers MUST assign UUID before first save and never reassign.

INVARIANT 6 — FhirTransformService is read-path only
  The FhirTransformService MUST only be called to produce a FHIR
  resource from an already-persisted OE object (for GET responses).
  It MUST NOT be called with side effects (no saves, no HTTP calls).

INVARIANT 7 — Error responses are FHIR OperationOutcome
  All provider exceptions MUST be HAPI exception types
  (ResourceNotFoundException, InvalidRequestException,
   UnprocessableEntityException, InternalErrorException).
  These are automatically serialized by HAPI as FHIR OperationOutcome JSON.
  Never return raw Spring ResponseEntity from a provider method.
  
   HTTP POST /fhir/Patient
         │
         ▼
    InternalFhirApi.receivePostFhirRequest()
         │  RequestDispatcher.forward() to /fhir/facade
         ▼
    FhirRestfulServer  (no PatientProvider exists yet)
         │  no IResourceProvider for Patient found
         ▼
    404 / unhandled  OR  falls through to old HAPI proxy
         │
         ▼
    fhir.openelis.org:8080  (separate HAPI JPA container)
         │  HAPI JPA writes Patient to its own tables
         ▼
    HAPI internal PostgreSQL tables  ← Patient lands here ONLY
         │
         │  ← clinlims.patient is NOT updated
         │  ← polling scheduled every 2 minutes
         │  ← if poll succeeds: TaskInterpreter runs
         │  ← if poll fails:    desync, data invisible to OE
         ▼
    clinlims.patient  ← eventually, maybe, 2+ minutes later
  
  
  AFTER: POST /fhir/facade/Patient  (write a new patient)
  
    HTTP POST /fhir/facade/Patient
         │
         ▼
    InternalFhirApi.receivePostFhirRequest()
         │  RequestDispatcher.forward() to /fhir/facade
         ▼
    FhirRestfulServer
         │  PatientProvider registered as @Component
         │  HAPI routes POST → @Create
         ▼
    PatientProvider.create(Patient fhirPatient)
         │  @Transactional begins
         │
         ├── parse fhirPatient.name  → Person.firstName/lastName
         ├── parse fhirPatient.gender → Patient.gender
         ├── parse fhirPatient.birthDate → Patient.birthDate
         ├── parse fhirPatient.identifier[] → PatientIdentity[]
         │
         ├── personService.save(person)
         │     → INSERT INTO clinlims.person
         │
         ├── patientService.save(patient)
         │     → INSERT INTO clinlims.patient
         │          (fhir_uuid = assigned UUID)  ← lands here IMMEDIATELY
         │
         ├── patientIdentityService.saveAll(identities)
         │     → INSERT INTO clinlims.patient_identity[]
         │
         │  @Transactional commits
         ▼
    HTTP 201  { "resourceType":"Patient", "id":"uuid", ... }
         │
         │  ← clinlims.patient is updated SYNCHRONOUSLY
         │  ← no polling needed
         │  ← no second server involved
         │  ← GET /fhir/facade/Patient/uuid works immediately
         ▼
    DONE. Single round trip. Single database. Zero drift possible.
  
  
  ═══════════════════════════════════════════════════════════════════════
  
  BEFORE: GET /fhir/Task?status=requested  (poll for inbound orders)
  
    FhirApiWorkflowService.pollForRemoteTasks()
         │  @Scheduled every 120,000 ms  (2 minutes)
         ▼
    for each remoteStorePath in fhirConfig.getRemoteStorePaths():
         │
         ▼
    IGenericClient sourceFhirClient = fhirUtil.getFhirClient(remoteStorePath)
         │  HTTP GET to remote HAPI server
         ▼
    sourceFhirClient.search().forResource(Task.class)
         .where(Task.STATUS.exactly().code("requested"))
         .where(Task.OWNER.hasAnyOfIds(remoteStoreIdentifier))
         .execute()
         │  Bundle of Tasks returned
         ▼
    for each Task in bundle:
         │
         ▼
    processTaskImportOrder(remoteTask, remoteStorePath, ...)
         │
         ├── saveRemoteTaskAsLocalTask()
         │     → HTTP GET to fetch ServiceRequest, Patient,
         │       Specimen, Practitioner from remote server
         │     → fhirPersistanceService.createUpdateFhirResourcesInFhirStore()
         │         → HTTP PUT to local HAPI server
         │
         ├── TaskWorker.handleOrderRequest()
         │     → DBOrderPersister.persist()
         │         → INSERT INTO clinlims.electronic_order
         │         → INSERT INTO clinlims.sample (eventually)
         │
         │  ← latency: up to 2 minutes before order visible in OE
         │  ← 4+ HTTP round trips per order
         │  ← failure at any hop = order lost or duplicated
         ▼
    clinlims  ← order lands here 2+ minutes after creation
  
  
  AFTER: POST /fhir/facade/Task  (push inbound order directly)
  
    External system:
    HTTP POST /fhir/facade/Task
    {
      "resourceType": "Task",
      "status": "requested",
      "for": { "reference": "Patient/patient-uuid" },
      "basedOn": [{ "reference": "ServiceRequest/sr-uuid" }],
      "owner": { "reference": "Organization/lab-uuid" }
    }
         │
         ▼
    TaskProvider.create(Task fhirTask)
         │  @Transactional begins
         │
         ├── extractServiceRequests(fhirTask)
         │     → fetch ServiceRequest from request body or Bundle
         │
         ├── extractPatient(fhirTask)
         │     → PatientProvider resolves Patient/patient-uuid
         │       → patientService.getMatch("fhirUuid", patient-uuid)
         │
         ├── for each ServiceRequest:
         │     TaskWorker.handleOrderRequest()
         │       → DBOrderPersister.persist(messagePatient, eOrder)
         │           → INSERT INTO clinlims.electronic_order
         │           → INSERT INTO clinlims.sample
         │                (fhir_uuid = task.id from POST body)
         │
         │  @Transactional commits
         ▼
    HTTP 201  { "resourceType":"Task", "id":"task-uuid",
                 "status":"accepted", ... }
         │
         │  ← order visible in OE UI IMMEDIATELY
         │  ← zero polling latency
         │  ← zero HTTP hops between internal services
         │  ← one transaction — either fully saved or fully rolled back
         ▼
    DONE.
  ```
  
  ---
  
  ### 20. The Complete Interaction Sequence Diagram — Scenario A End to End
  
  This traces the complete new-architecture flow when a lab tech enters an order in the OE UI and an external system later reads the result:
  
  ```/dev/null/scenario-a-sequence.txt#L1-90
  Lab Tech enters order in OE UI
  ───────────────────────────────
    Browser → POST /SamplePatientEntry
                  │
                  ▼
    SamplePatientEntryRestController.samplePatientEntrySave()
                  │
                  ├── samplePatientService.persistData()   @Transactional
                  │     ├── personService.save(person)
                  │     │     → clinlims.person  (row created)
                  │     ├── patientService.save(patient)
                  │     │     → clinlims.patient (fhir_uuid assigned + stored)
                  │     ├── sampleService.insert(sample)
                  │     │     → clinlims.sample  (fhir_uuid assigned + stored)
                  │     ├── sampleItemService.insert(sampleItem)
                  │     │     → clinlims.sample_item (fhir_uuid assigned + stored)
                  │     └── analysisService.insert(analysis)
                  │           → clinlims.analysis (fhir_uuid assigned + stored)
                  │     COMMIT  ← ALL data in clinlims in one transaction
                  │
                  ├── eventPublisher.publishEvent(SamplePatientUpdateDataCreatedEvent)
                  │     (Odoo listener picks this up — unrelated to FHIR)
                  │     SampleFhirTransformEventListener → DELETED in new arch
                  │
                  ▼
    Browser ← 200 OK  (OE UI shows order created)
  
                     ↑
                     │  At this point, the FHIR facade can already serve
                     │  any GET request for this order — because clinlims
                     │  has fhir_uuid columns populated. No sync needed.
                     │
  
  Results entered by lab tech
  ────────────────────────────
    Browser → POST /ResultsEntry
                  │
                  ▼
    ResultsEntryController → resultService.save(result)
                  │     → clinlims.result (fhir_uuid assigned + stored)
                  ▼
    Browser ← 200 OK
  
  Pathologist validates and finalizes
  ────────────────────────────────────
    Browser → POST /ResultValidation
                  │
                  ▼
    ResultValidationController → analysisService.update(analysis)
                  │     status = FINALIZED
                  │     → clinlims.analysis.status_id = FINALIZED
                  ▼
    Browser ← 200 OK
  
                     ↑
                     │  DiagnosticReport is now answerable by the facade
                     │  because: analysis.statusId = Finalized
                     │           analysis.fhirUuid is set
                     │           results are in clinlims.result
                     │
  
  External system reads the DiagnosticReport
  ───────────────────────────────────────────
    External: GET /fhir/facade/DiagnosticReport?patient=patient-uuid&status=final
                  │
                  ▼
    DiagnosticReportProvider.search(patient=patient-uuid, status=final)
                  │
                  ├── patientService.getMatch("fhirUuid", patient-uuid)
                  │     → clinlims.patient lookup  ← direct DB query
                  │
                  ├── sampleService.getSamplesForPatient(oePatient.getId())
                  │     → List<Sample> from clinlims.sample
                  │
                  ├── for each Sample:
                  │     analysisService.getAnalysesBySampleId(sample.getId())
                  │     filter: statusService.matches(statusId, FINALIZED)
                  │
                  ├── for each finalized Analysis:
                  │     fhirTransformService.transformResultToDiagnosticReport(analysis)
                  │       reads: analysis.fhirUuid → DiagnosticReport.id
                  │       reads: resultService.getResultsByAnalysis(analysis)
                  │              → result.fhirUuid → Observation references
                  │       reads: patient.fhirUuid → subject reference
                  │       reads: sampleItem.fhirUuid → specimen reference
                  │
                  ▼
    HTTP 200 Bundle{
      "resourceType": "Bundle", "type": "searchset",
      "entry": [{
        "resource": {
          "resourceType": "DiagnosticReport",
          "id": "analysis-fhir-uuid",
          "status": "final",
          "subject": { "reference": "Patient/patient-uuid" },
          "result": [
            { "reference": "Observation/result-uuid-1" },
            { "reference": "Observation/result-uuid-2" }
          ],
          "code": { "coding": [{ "system": "http://loinc.org",
                                 "code": "58410-2" }] }
        }
      }]
    }
  ```
  
  ---
  
  ### 21. The Complete Interaction Sequence Diagram — Scenario B End to End
  
  This traces the complete new-architecture flow when an external system pushes an order into OpenELIS:
  
  ```/dev/null/scenario-b-sequence.txt#L1-80
  External system (iSante, OpenMRS, SHR) creates an order
  ─────────────────────────────────────────────────────────
    External: POST /fhir/facade/Task
    {
      "resourceType": "Task",
      "id": "ext-gen-task-uuid",
      "status": "requested",
      "priority": "routine",
      "for": { "reference": "Patient/ext-patient-uuid" },
      "basedOn": [{
        "reference": "ServiceRequest/ext-sr-uuid"
      }],
      "owner": {
        "reference": "Organization/target-lab-org-uuid"
      },
      "contained": [{
        "resourceType": "ServiceRequest",
        "id": "ext-sr-uuid",
        "code": {
          "coding": [{
            "system": "http://loinc.org",
            "code": "58410-2"
          }]
        },
        "identifier": [{
          "system": "http://openelis-global.org/order_number",
          "value": "EXTORDER-001"
        }],
        "subject": { "reference": "Patient/ext-patient-uuid" }
      }, {
        "resourceType": "Patient",
        "id": "ext-patient-uuid",
        "name": [{ "family": "Traore", "given": ["Boubacar"] }],
        "gender": "male",
        "birthDate": "1975-11-03"
      }]
    }
                  │
                  ▼
    InternalFhirApi.receivePostFhirRequest()
                  │  forward → /fhir/facade/Task
                  ▼
    FhirRestfulServer → TaskProvider.create(fhirTask)
                  │  @Transactional begins
                  │
                  ├── extractContainedPatient(fhirTask)
                  │     Patient fhirPatient = fhirTask.getContained()
                  │         .stream().filter(r -> r instanceof Patient)
                  │         .findFirst()
                  │
                  ├── extractContainedServiceRequests(fhirTask)
                  │     List<ServiceRequest> srs = fhirTask.getContained()
                  │         .stream().filter(r -> r instanceof ServiceRequest)
                  │
                  ├── for each ServiceRequest:
                  │
                  │     TaskWorker worker = new TaskWorker(
                  │         fhirTask, jsonEncoded, sr, fhirPatient)
                  │     worker.setInterpreter(taskInterpreter)
                  │     worker.setExistanceChecker(dbOrderExistanceChecker)
                  │     worker.setPersister(dbOrderPersister)
                  │
                  │     TaskResult result = worker.handleOrderRequest()
                  │       │
                  │       ├── TaskInterpreterImpl.interpret(task, sr, patient)
                  │       │     ├── createPatientFromFHIR()
                  │       │     │     → MessagePatient{lastName:"Traore",...}
                  │       │     ├── createTestFromFHIR(sr)
                  │       │     │     → testService.getTestsByLoincCode("58410-2")
                  │       │     │     → Test{name:"CBC"} found in OE
                  │       │     └── extractOrderInformation(sr)
                  │       │           → labOrderNumber = "EXTORDER-001"
                  │       │
                  │       ├── DBOrderExistanceChecker.check("EXTORDER-001")
                  │       │     → eOrderService.getElectronicOrdersByExternalId()
                  │       │     → NOT_FOUND  (first time)
                  │       │
                  │       └── DBOrderPersister.persist(messagePatient, eOrder)
                  │             ├── persist(messagePatient)
                  │             │     → patient lookup by GUID
                  │             │     → if not found: createNewPatient()
                  │             │         → INSERT INTO clinlims.person
                  │             │         → INSERT INTO clinlims.patient
                  │             │              (fhir_uuid = ext-patient-uuid)
                  │             │
                  │             ├── eOrder.setPatient(patient)
                  │             ├── eOrder.setExternalId("EXTORDER-001")
                  │             ├── eOrder.setType(FHIR)
                  │             └── eOrderService.insert(eOrder)
                  │                   → INSERT INTO clinlims.electronic_order
                  │
                  │  @Transactional commits
                  │
                  ├── sample = sampleService.getSampleByReferringId("EXTORDER-001")
                  ├── Task responseTask = fhirTransformService.transformToTask(sample)
                  │
                  ▼
    HTTP 201  {
      "resourceType": "Task",
      "id": "ext-gen-task-uuid",
      "status": "accepted",
      "for": { "reference": "Patient/ext-patient-uuid" },
      "basedOn": [{ "reference": "ServiceRequest/ext-sr-uuid" }]
    }
                  │
                  │  ← order appears in OE electronic orders queue IMMEDIATELY
                  │  ← lab tech sees it in OE UI without any polling
                  │  ← no 2-minute wait
                  │  ← no 4-hop HTTP chain
                  │  ← one atomic transaction
                  ▼
    Lab tech opens OE → Electronic Orders → sees "EXTORDER-001" instantly
  ```
  
  ---
  
  ### 22. Final Architecture State — Single Diagram Summary
  
  ```/dev/null/final-state-summary.txt#L1-70
  ╔═══════════════════════════════════════════════════════════════════════╗
  ║          FHIR FACADE — COMPLETE FINAL ARCHITECTURE                   ║
  ╚═══════════════════════════════════════════════════════════════════════╝
  
    External Systems                    OpenELIS UI (Browser)
    (iSante, OpenMRS, SHR, etc.)        (Lab Tech, Pathologist)
          │                                      │
          │  FHIR R4 REST                        │  Spring MVC
          │  GET/POST/PUT                        │  Forms / REST
          ▼                                      ▼
    ┌─────────────────────────────────────────────────────────┐
    │                    NGINX Proxy                          │
    └──────────────────────────┬──────────────────────────────┘
                               │
                  ┌────────────┴────────────┐
                  │                         │
                  ▼                         ▼
    ┌─────────────────────┐   ┌─────────────────────────────────┐
    │  InternalFhirApi    │   │  Spring DispatcherServlet       │
    │  /fhir/**           │   │  /  (all OE UI controllers)     │
    │  (gateway)          │   │                                 │
    └──────────┬──────────┘   └──────────────┬──────────────────┘
               │ forward all                  │
               │ to facade                    │
               ▼                             ▼
    ┌───────────────────────────────────────────────────────────┐
    │            FhirRestfulServer   /fhir/facade/*             │
    │            (HAPI Plain Server — routing only)             │
    │                                                           │
    │  PatientProvider   TaskProvider    ServiceRequestProvider │
    │  SpecimenProvider  ObsProvider     DiagReportProvider     │
    │  PractitionerProvider              OrganizationProvider   │
    └────────────────────────┬──────────────────────────────────┘
                             │
                             │ direct Java method calls
                             │ (no HTTP, no network hops)
                             ▼
    ┌───────────────────────────────────────────────────────────┐
    │                 OpenELIS SERVICE LAYER                    │
    │                                                           │
    │  PatientService      SampleService     AnalysisService    │
    │  SampleItemService   ResultService     ProviderService    │
    │  OrganizationService SamplePatientEntryService            │
    │                                                           │
    │  FhirTransformService  (READ path only — OE → FHIR R4)   │
    │  TaskWorker + TaskInterpreter + DBOrderPersister          │
    └────────────────────────┬──────────────────────────────────┘
                             │
                             │ Hibernate ORM
                             ▼
    ┌───────────────────────────────────────────────────────────┐
    │           clinlims  (PostgreSQL)                          │
    │                                                           │
    │  patient(fhir_uuid) ←→ Patient resource ID               │
    │  sample(fhir_uuid)  ←→ Task resource ID                  │
    │  analysis(fhir_uuid)←→ ServiceRequest + DiagReport ID    │
    │  sample_item(fhir_uuid)←→ Specimen resource ID           │
    │  result(fhir_uuid)  ←→ Observation resource ID           │
    │  provider(fhir_uuid)←→ Practitioner resource ID          │
    │  organization(fhir_uuid)←→ Organization resource ID      │
    │  referral(fhir_uuid)←→ Task (referral) resource ID       │
    │                                                           │
    │  ONE database. ONE source of truth. ZERO drift.          │
    └───────────────────────────────────────────────────────────┘
  ```
  
  ---
  
  That is the complete architectural and design specification — every layer, every component, every decision grounded in the actual code that exists in the project today. The design is fully implementable in the phased sequence described in Section 17, starting with the `PractitionerProvider` bug fixes as the first concrete code change.
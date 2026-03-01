Current HAPI JPA Server Design — Full Flow

There are **three distinct directions** of data movement in the current design. Let me walk through each one.

---

### Direction 1: External System → OpenELIS (Inbound Write — POST/PUT)

This is the path an external system (e.g. iSantePlus, OpenMRS) takes to push a FHIR resource into OpenELIS.

```/dev/null/flow-inbound-write.txt#L1-30
External System (iSantePlus / OpenMRS)
        |
        |  POST https://openelis-host/fhir/Task  (or Patient, ServiceRequest, etc.)
        v
InternalFhirApi  (@RestController, mapped /fhir/**)
        |
        |  ① strips "/fhir" prefix  →  "/Task"
        |  ② builds target URL     →  "/fhir/facade/Task"
        |  ③ RequestDispatcher.forward()  [same JVM, no network hop]
        v
FhirRestfulServer  (HAPI RestfulServer, servlet mapped /fhir/facade/*)
        |
        |  only PractitionerProvider is registered
        |  → any resource other than Practitioner: HAPI returns 404 / NOT_FOUND
        |  → Practitioner: routes to PractitionerProvider (@Create / @Update)
        v
PractitionerProvider
        |  saves to clinlims via ProviderService / PersonService
        v
clinlims (PostgreSQL)
```

**Key problem here**: for all resources except `Practitioner`, the facade has no provider, so the write dies at the HAPI facade. The external system gets a 404.

---

### Direction 2: OpenELIS → External HAPI JPA Server (Outbound Sync — the "push" side)

This is how OE keeps the external HAPI JPA server in sync whenever OE data changes internally (e.g. a lab technician creates a sample via the OE UI).

```/dev/null/flow-outbound-sync.txt#L1-40
Lab Technician saves a Sample in the OE UI
        |
        v
SamplePatientEntryController  (Spring MVC controller)
        |
        |  saves to clinlims via SampleService, PatientService, etc.
        |  then fires a Spring Application Event:
        |  applicationEventPublisher.publishEvent(SamplePatientUpdateDataCreatedEvent)
        v
SampleFhirTransformEventListener  (@Async @EventListener)
        |
        |  calls FhirTransformService.transformPersistOrderEntryFhirObjects()
        v
FhirTransformServiceImpl
        |
        |  ① translates OE domain objects  →  FHIR resources
        |     (Patient, Task, ServiceRequest, Specimen, etc.)
        |  ② calls FhirPersistanceService.createUpdateFhirResourcesInFhirStore()
        v
FhirPersistanceServiceImpl
        |
        |  builds a FHIR Transaction Bundle (PUT requests)
        |  sends it via HTTP to → localFhirStorePath
        |     (org.openelisglobal.fhirstore.uri  e.g. http://hapi-fhir:8080/fhir)
        v
External HAPI JPA Server  (separate Docker container)
        |
        |  persists all resources into its own internal H2/Postgres DB
        v
HAPI JPA Server's own database  ← SECOND copy of the data
```

This is the **drift source** — two separate databases now hold copies of the same data, synchronized only by this async best-effort HTTP push. If the push fails, the HAPI server is out of sync with clinlims.

---

### Direction 3: External HAPI JPA Server → OpenELIS (Inbound Poll — the "pull" side)

This is how OE discovers new orders that were placed by external systems directly into the HAPI JPA server (not via OE's own `/fhir` endpoint).

```/dev/null/flow-inbound-poll.txt#L1-45
FhirApiWorkFlowServiceImpl
        |
        |  @Scheduled  every 2 minutes (configurable)
        |  pollForRemoteTasks()  →  processWorkflow(ResourceType.Task)
        v
        |  for each remoteStorePath in fhirConfig.getRemoteStorePaths():
        |
        |  ① beginTaskImportOrderPath(remoteStorePath)
        |     - calls remoteStorePath/Task?status=requested  via IGenericClient
        |     - for each new Task found on the remote server:
        |         → fetches linked Patient, ServiceRequest, Specimen from remote
        |         → saves them to clinlims via IOrderPersister
        |         → saves FHIR copies to localFhirStorePath via FhirPersistanceService
        |
        |  ② beginTaskCheckIfAcceptedPath(remoteStorePath)
        |     - checks if any remote Tasks changed to RECEIVED
        |     - updates the local HAPI copy via FhirPersistanceService
        |
        |  ③ beginTaskImportResultsPath(remoteStorePath)
        |     - checks if any remote Tasks changed to COMPLETED
        |     - imports the DiagnosticReport / Observations back into OE
        v
clinlims (PostgreSQL)  +  local HAPI JPA Server  ← both get updated
```

---

### Direction 4: External System reads FHIR data (GET)

When an external system or OE's own UI wants to read FHIR data:

```/dev/null/flow-get-read.txt#L1-25
External System or OE Internal UI
        |
        |  GET https://openelis-host/fhir/Patient?identifier=...
        v
InternalFhirApi  (@GetMapping("/**"))
        |
        |  forwardGetRequest()  — NOT a servlet forward, this is a real HTTP call
        |  builds URL:  fhirConfig.getLocalFhirStorePath() + "/Patient?identifier=..."
        |              (e.g. http://hapi-fhir:8080/fhir/Patient?identifier=...)
        |  fires outbound HTTP GET via Apache CloseableHttpClient
        v
External HAPI JPA Server  (separate Docker container)
        |
        |  queries its own JPA database
        |  returns FHIR Bundle JSON
        v
InternalFhirApi
        |
        |  parses JSON response, wraps in ResponseEntity
        v
External System receives the FHIR response
```

---

### The Boot-Time Reconciliation (on every startup)

```/dev/null/flow-boot-reconcile.txt#L1-20
Application starts up
        |
        v
RegisterFhirHooksTask  (@PostConstruct)
        |
        |  connects to localFhirStorePath (HAPI JPA server)
        |  registers FHIR Subscriptions for each configured resource type
        |  (Task, Patient, ServiceRequest, etc.)
        |
        |  also saves a DataExportTask targeting the fhirSubscriber URL
        |  (the external system that wants push notifications)
        v
External HAPI JPA Server
        |  now has Subscription records registered
        |  will push REST-hook notifications to fhirSubscriber on every create/update
        v
FhirTransformationController  (also runs at boot / on-demand)
        |
        |  bulk reconciles existing OE records → pushes to HAPI JPA server
        |  via FhirTransformService.transformPersistPatients() etc.
```

---

### The Complete System Picture

```/dev/null/full-system.txt#L1-35
┌─────────────────────────────────────────────────────────────────┐
│                      OpenELIS Process (JVM)                     │
│                                                                 │
│  InternalFhirApi (/fhir/**)                                     │
│    ├── GET  → HTTP call out → [HAPI JPA Server] → returns JSON  │
│    ├── POST → servlet forward → FhirRestfulServer (/fhir/facade)│
│    └── PUT  → servlet forward → FhirRestfulServer (/fhir/facade)│
│                        │                                        │
│                        └── only PractitionerProvider wired      │
│                                                                 │
│  SampleFhirTransformEventListener (async, event-driven)         │
│    └── on every OE save → FhirTransformService                  │
│           └── FhirPersistanceService → HTTP PUT → [HAPI JPA]   │
│                                                                 │
│  FhirApiWorkFlowServiceImpl (@Scheduled every 2 min)            │
│    └── polls [Remote HAPI] → imports Tasks into clinlims        │
│           └── also pushes copies back to [Local HAPI JPA]       │
│                                                                 │
│  RegisterFhirHooksTask (@PostConstruct)                         │
│    └── registers FHIR Subscriptions on [Local HAPI JPA]         │
│                                                                 │
│  clinlims (PostgreSQL)  ← authoritative OE source of truth      │
└─────────────────────────────────────────────────────────────────┘
          ▲  HTTP over network          ▲  HTTP over network
          │                            │
┌─────────────────┐          ┌─────────────────────┐
│ Local HAPI JPA  │          │  Remote HAPI / EMR   │
│ Server          │          │  (iSantePlus etc.)   │
│ (Docker sidecar)│          │                      │
│ Own DB (2nd copy│          │                      │
│ of the data)    │          │                      │
└─────────────────┘          └─────────────────────┘
```

---

### Summary of the Core Problems

| Issue | Root Cause |
|---|---|
| **Two databases** | clinlims + HAPI JPA server's own DB both store the same data |
| **Drift** | The async HTTP push from `FhirPersistanceService` can fail silently |
| **GET reads stale data** | GETs go to HAPI JPA — if a push failed, the data there is wrong |
| **Polling latency** | Inbound orders take up to 2 minutes to appear in OE |
| **Dead-end writes** | POST/PUT for anything other than `Practitioner` returns 404 at the facade |
| **Boot reconciliation** | Needed precisely *because* drift accumulates between the two stores |

This is exactly why the native facade design replaces all of this — one database, one transaction, no polling, no sync.
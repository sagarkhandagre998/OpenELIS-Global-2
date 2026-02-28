What the Project Is Saying & Why It's Needed

### 1. The Core Problem: Two Databases, One Source of Truth

The current architecture has a **fundamental structural split** that creates a class of bugs that cannot be fully eliminated:

```/dev/null/architecture-current.txt#L1-10
OpenELIS App (Spring MVC)
        ↓  writes first
  PostgreSQL DB (clinlims)   ← the REAL source of truth
        ↓  then asynchronously
  FhirTransformService       ← reads back from Postgres
        ↓  sends over HTTP
  HAPI FHIR JPA Server       ← a second, parallel database
  (also backed by Postgres)
```

These are two completely separate databases that are **always at risk of diverging**. OpenELIS commits to its own `clinlims` PostgreSQL schema first. Then, asynchronously and over a network HTTP call, it tries to mirror data into the HAPI FHIR JPA Server. That HAPI server also has its own backing PostgreSQL tables (you can see this in `fhir/hapi_application.yaml` — it connects to the same `clinlims` database but uses JPA/Hibernate to manage its own HAPI-internal tables separately from OpenELIS's tables).

---

### 2. How the Current Sync Path Actually Works (and Where It Breaks)

**Scenario A (OpenELIS → External):**

The flow in code is:

1. **Controller** (`SamplePatientEntryRestController.samplePatientEntrySave`) calls `samplePatientService.persistData()` — this commits to PostgreSQL.
2. It then fires a Spring `ApplicationEvent` (`SamplePatientUpdateDataCreatedEvent`).
3. `SampleFhirTransformEventListener` catches it `@Async` — meaning **in a separate thread**, after the HTTP response may have already been returned.
4. `FhirTransformService.transformPersistOrderEntryFhirObjects()` reads back from Postgres, constructs FHIR R4 objects (`Task`, `Patient`, `Specimen`, `ServiceRequest`, etc.)
5. Those objects are pushed into `FhirPersistanceServiceImpl` which builds a FHIR transaction Bundle and sends it over HTTP to `localFhirClient` — which is just an HTTP client pointed at `org.openelisglobal.fhirstore.uri`.
6. The HAPI FHIR Server receives that Bundle and stores it in its own JPA tables.

**The failure points in this chain:**

- **Network failure**: The HTTP call from step 5 can fail silently. The `@Async` event listener has a try/catch that only logs the error — the data is in Postgres but not in FHIR.
- **Race condition in `transformPersistObjectsUnderSamples`**: It reads `fhirUuid` from domain objects and if they're null (which they are for newly created objects on the first pass), it calls `UUID.randomUUID()` in-memory but **never persists that UUID back to Postgres**. The `transformPersistPatients` method does the same — sets `fhirUuid` on the object but never saves it.
- **Boot-time reconciliation is required**: `FhirTransformationController.transformOEObjectsOnBoot()` is scheduled with `fixedRate = Long.MAX_VALUE` and runs once at startup specifically to backfill any records that are missing from FHIR. This is a direct admission that sync drift is expected.
- **The `isDesynchronized()` check**: In `FhirApiWorkFlowServiceImpl` there is a check `providerService.getProviderByFhirId(provider.getFhirUuid()).isDesynchronized()` — there's a `DesynchronousCapable` interface in the codebase specifically to track records that fell out of sync.
- **The `@Async` transform is not transactional with the DB commit**: The FHIR push happens outside the original database transaction. If the JVM crashes between step 1 and step 5, the data exists in Postgres but not in FHIR, with no automatic recovery.

**Scenario B (External → OpenELIS):**

The HAPI FHIR Server polls-based inbound flow (`FhirApiWorkFlowServiceImpl.pollForRemoteTasks`) runs on a **scheduled 2-minute interval** (`fixedRateString = "${org.openelisglobal.remote.poll.frequency:120000}"`). An external system creates a Task on the HAPI server and OpenELIS may not see it for up to 2 minutes. After seeing it, `TaskWorker` → `DBOrderPersister.persist()` writes to Postgres — but then a separate flow is needed to sync *that* data back to FHIR again.

---

### 3. The Deeper Architectural Problems

**A. Infrastructure Coupling**

The `docker-compose.yml` shows a separate `fhir.openelis.org` container (`external-fhir-api`). Every deployment of OpenELIS **requires** a separately running HAPI FHIR JPA server. If that container goes down, FHIR interoperability is completely broken and Scenario B stops working. The HAPI server also connects to the same PostgreSQL database, doubling the connection load.

**B. The `fhir_uuid` Column Problem**

Every core table in the `clinlims` schema has a `fhir_uuid` column added via Liquibase (`uuid_columns.xml`): `analysis`, `result`, `sample_item`, `organization`, `patient`, `sample`, `provider`, `referral`. These UUIDs exist solely to serve as stable FHIR resource IDs. But they are nullable and not always populated before the async transform runs, causing the `if (xxx.getFhirUuid() == null) { xxx.setFhirUuid(UUID.randomUUID()); }` defensive code scattered across `FhirTransformServiceImpl` — around **10 separate places** in that one file alone.

**C. The `FhirTransformationController` Batch Reconciliation**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/fhir/transormation/controller/FhirTransformationController.java#L43-46
@Scheduled(initialDelay = 10 * 1000, fixedRate = Long.MAX_VALUE)
private void transformOEObjectsOnBoot() throws FhirLocalPersistingException, IOException {
    transformPersistMissingFhirObjects(false, 100, 1, true);
}
```

This runs a full table scan of all `Patients` and all `Samples` on every boot, pushing everything into HAPI. This is purely compensatory infrastructure to handle drift that the system itself causes.

**D. No FHIR Transactions From External Systems Into OpenELIS Directly**

If an external system wants to do `POST /fhir/Patient` to create a patient in OpenELIS, `InternalFhirApi` just **forwards** that HTTP request to the HAPI server as a proxy. The HAPI server creates the Patient in its own JPA tables. But OpenELIS's own `patient` table in `clinlims` is **never updated**. The data now lives only in HAPI. For OpenELIS to use it, the `FhirApiWorkflowService` polling has to discover it and transform it back. This is the round-trip problem.

**E. The Subscribe-and-Export Layer (`RegisterFhirHooksTask` / `DataExportService`)**

At startup, OpenELIS registers FHIR `Subscription` resources on the HAPI server and also configures a `DataExportTask`. This is a third mechanism (beyond event listeners and scheduled polling) trying to keep things in sync. Three separate sync mechanisms means three separate failure modes.

---

### 4. What the New Architecture Must Be

The project wants to eliminate the HAPI FHIR JPA Server as the data store entirely and instead build a **native FHIR facade** that sits directly in front of the OpenELIS service layer. The concept is:

```/dev/null/architecture-new.txt#L1-20
External FHIR Client
        ↓  HTTP  GET/POST/PUT   (standard FHIR R4 REST)
  FHIR Facade Layer  (lives inside OpenELIS, served by HAPI Plain Server or custom RestfulServer)
        ↓  reads/writes directly
  OpenELIS Service Layer  (PatientService, SampleService, AnalysisService, etc.)
        ↓
  PostgreSQL clinlims  ← the ONE and ONLY data store
```

Instead of HAPI's JPA persistence, you implement HAPI's **Plain Server** (`RestfulServer`) with custom `IResourceProvider` implementations for each FHIR resource type. Each provider directly calls OpenELIS services. There is no second database. There is no async sync. There is no drift.

**The specific FHIR resources that need providers** based on what `FhirTransformService` currently handles:
- `Patient` → `PatientService`
- `Task` → `SampleService` (Sample is the Task)
- `ServiceRequest` → `AnalysisService` (Analysis is the ServiceRequest)
- `Specimen` → `SampleItemService`
- `DiagnosticReport` → `AnalysisService` + `ResultService`
- `Observation` → `ResultService`
- `Practitioner` → `ProviderService`
- `Organization` → `OrganizationService`
- `Location` → `StorageLocationFhirTransform` shows this is already partially done

**The existing `FhirRestfulServer`** at `org.openelisglobal.fhir.servlets.FhirRestfulServer` is already registered as a HAPI `RestfulServer`. It currently scans for `IResourceProvider` beans but there are none implemented — that servlet is the **exact hook** the facade needs to be built on.

---

### 5. What Stays, What Changes, What Gets Removed

| Component | Current Role | After Facade |
|---|---|---|
| `FhirRestfulServer` | Empty shell, proxies to HAPI | Becomes the real FHIR endpoint, routes to providers |
| `FhirTransformService` | OE → FHIR transformation | Reused as read-path transformers for GET responses |
| `FhirPersistanceService` | Writes to external HAPI | **Replaced** by facade write-path (FHIR → OE service calls) |
| `FhirApiWorkflowService` | Polls HAPI for inbound tasks | **Simplified** — external systems POST directly to facade |
| `RegisterFhirHooksTask` | Registers subscriptions on HAPI | **Removed** |
| `FhirTransformationController` | Boot-time reconciliation scan | **Removed** |
| `SampleFhirTransformEventListener` | Async post-save sync | **Removed** — facade reads live |
| `FhirConfig.localFhirStorePath` | Points to HAPI HTTP endpoint | Points to facade's own URL or removed |
| External HAPI Docker container | Required infrastructure | **Optional** or removed |
| `fhir_uuid` columns | Stable IDs for HAPI resources | Kept — used as FHIR resource IDs in facade responses |

The `FhirTransformService` transform methods (`transformToFhirPatient`, `transformToServiceRequest`, `transformResultToObservation`, etc.) are all still valuable — they become the **read-side** of the facade (GET handlers call them to produce FHIR responses). The new work is building the **write-side**: parsing an incoming FHIR resource and calling the right OpenELIS service methods to persist it — which is what `TaskInterpreterImpl` and `DBOrderPersister` do for the Task/order flow, and needs to be done similarly for all resource types.
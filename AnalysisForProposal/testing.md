Testing Strategy

### Unit Tests

Every new provider class gets a dedicated unit test class. Mocking uses Mockito (already in the project's test dependencies). All tests use JUnit 4 (`org.junit.Test`).

| Class Under Test | Test Class | What is Mocked |
|---|---|---|
| `PatientProvider` | `PatientProviderTest` | `PatientService`, `PersonService`, `PatientIdentityService`, `FhirTransformService` |
| `TaskProvider` | `TaskProviderTest` | `SampleService`, `TaskWorker`, `DBOrderPersister`, `DBOrderExistanceChecker`, `FhirTransformService` |
| `ServiceRequestProvider` | `ServiceRequestProviderTest` | `AnalysisService`, `FhirTransformService` |
| `SpecimenProvider` | `SpecimenProviderTest` | `SampleItemService`, `FhirTransformService` |
| `ObservationProvider` | `ObservationProviderTest` | `ResultService`, `FhirTransformService` |
| `DiagnosticReportProvider` | `DiagnosticReportProviderTest` | `AnalysisService`, `ResultService`, `PatientService`, `SampleService`, `FhirTransformService` |
| `OrganizationProvider` | `OrganizationProviderTest` | `OrganizationService`, `FhirTransformService` |
| `LocationProvider` | `LocationProviderTest` | `StorageRoomService`, `StorageDeviceService`, `OrganizationService`, `StorageLocationFhirTransform` |
| `EncounterProvider` | `EncounterProviderTest` | `SampleEncounterService` |
| `PractitionerProvider` | `PractitionerProviderTest` | `ProviderService`, `PersonService`, `FhirTransformService` |

**Key unit test scenarios:**

- `PatientProvider.read()` when UUID not found in `clinlims.patient` → throws `ResourceNotFoundException`
- `PatientProvider.create()` with no `id` in the request body → UUID is auto-assigned before `patientService.save()` is called
- `PatientProvider.create()` when `personService.save()` throws → transaction rolls back, no patient row written
- `TaskProvider.create()` with a duplicate order number → `DBOrderExistanceChecker` returns `EXISTS` → no second insert attempted
- `DiagnosticReportProvider.read()` for an analysis that exists but is not finalized → throws `ResourceNotFoundException`
- `LocationProvider.read()` UUID not matched in any storage table → falls back to `organizationService` lookup before throwing `ResourceNotFoundException`
- `EncounterProvider.create()` → saves to `sample_encounter` table with no HTTP calls to any remote server
- `PractitionerProvider.create()` → `fhirTransformServiceImpl` is called through the injected bean, not a manually instantiated object

---

### Integration Tests

Integration tests use the existing OpenELIS Spring context test pattern (`BaseWebContextSensitiveTest`). Each test operates within a real Spring context against an in-memory database.

**Phase 2 Integration Tests (`PatientFacadeIntegrationTest`):**

```/dev/null/PatientFacadeIntegrationTest.java#L1-1
test_createPatient_writesToClinlimsAndReturns201()
  1. POST a valid FHIR Patient JSON to PatientProvider.create()
  2. Assert: HTTP 201 returned with Location header containing the assigned UUID
  3. Assert: clinlims.patient has a new row with fhir_uuid matching the returned ID
  4. Assert: clinlims.person has the corresponding name row
  5. Assert: GET /fhir/facade/Patient/{uuid} immediately returns the same patient

test_readPatient_unknownUuid_returns404()
  1. Call PatientProvider.read() with a random UUID not in clinlims
  2. Assert: ResourceNotFoundException is thrown
  3. Assert: HAPI serializes it as OperationOutcome in the response

test_searchPatient_byFamilyName_returnsMatchingBundle()
  1. Insert 2 patients in clinlims with lastName = "Diallo", 1 with "Traore"
  2. Call PatientProvider.search() with family = "Diallo"
  3. Assert: Bundle contains exactly 2 entries
  4. Assert: Both entries have fhir_uuid matching the inserted rows
```

**Phase 4 Integration Tests (`TaskFacadeIntegrationTest`):**

```/dev/null/TaskFacadeIntegrationTest.java#L1-1
test_createTask_inboundOrder_appearsInElectronicOrdersImmediately()
  1. POST a FHIR Task with contained Patient and ServiceRequest to TaskProvider.create()
  2. Assert: clinlims.electronic_order has a new row with the external order number
  3. Assert: clinlims.patient has the patient from the Task's contained resources
  4. Assert: GET /fhir/facade/Task/{uuid} returns the Task with status = accepted
  5. Assert: No HTTP calls were made to any external FHIR server

test_createTask_duplicateOrderNumber_doesNotInsertSecondRow()
  1. POST the same Task twice with identical order number
  2. Assert: clinlims.electronic_order still has exactly 1 row for that order number
  3. Assert: Second response returns appropriate conflict status

test_createTask_partialFailure_rollsBackEntirely()
  1. POST a Task where the contained Patient has invalid data causing personService to throw
  2. Assert: clinlims.electronic_order has no row for this order
  3. Assert: clinlims.patient has no row for this patient
```

**Phase 5 Integration Tests (`LocationFacadeIntegrationTest`):**

```/dev/null/LocationFacadeIntegrationTest.java#L1-1
test_readStorageRoom_returnsFhirLocationWithCorrectPhysicalType()
  1. Insert a StorageRoom in clinlims with a known fhir_uuid
  2. Call LocationProvider.read() with that UUID
  3. Assert: Returned Location has physicalType.code = "ro"
  4. Assert: Location.id matches the StorageRoom.fhir_uuid

test_readLocation_byOrganizationFhirUuid_resolvesCorrectly()
  1. Insert an Organization in clinlims.organization with a known fhir_uuid
  2. Call LocationProvider.read() with that UUID (simulating Task.location resolution)
  3. Assert: A valid Location is returned, no ResourceNotFoundException

test_searchLocation_byPartOf_returnsChildHierarchy()
  1. Insert a StorageDevice with a known parent StorageRoom in clinlims
  2. Call LocationProvider.search() with partOf = StorageRoom UUID
  3. Assert: Bundle contains the StorageDevice as a child Location
```

**Phase 6 Integration Tests (`EncounterFacadeIntegrationTest`):**

```/dev/null/EncounterFacadeIntegrationTest.java#L1-1
test_createEncounter_storesCollectionDateAndSamplerLocally()
  1. POST a FHIR Encounter with period.start and participant to EncounterProvider.create()
  2. Assert: sample_encounter table has a new row with period_start populated
  3. Assert: GET /fhir/facade/Encounter/{uuid} returns the same Encounter

test_sampleEntryController_resolvesEncounterFromLocalFacade_notRemoteServer()
  1. Insert an Encounter in sample_encounter via EncounterProvider.create()
  2. Call SampleEntryByProjectController with a ServiceRequest referencing that Encounter UUID
  3. Assert: Collection date and sampler name are populated from local clinlims data
  4. Assert: No HTTP call was made to any remote OpenMRS server
```

---

### Regression Tests

Before final submission, run the full existing test suite to confirm no existing workflow is broken:

```/dev/null/regression.sh#L1-1
mvn clean install -DskipTests=false
```

All existing tests must pass with the facade providers registered **and** with the old `FhirApiWorkflowService` deleted.

---

### Manual End-to-End Test Plan

1. Deploy a local OpenELIS instance with all Liquibase changesets applied (including the `fhir_uuid` backfill and `sample_encounter` table)
2. Submit a lab order through the OE UI — verify `clinlims.sample.fhir_uuid` is populated immediately after save
3. Call `GET /fhir/facade/Task/{uuid}` with that UUID — verify the Task is returned without any HAPI container running
4. POST a FHIR Task from a simulated external system (e.g., curl) — verify the order appears in the OE electronic orders queue with zero polling delay
5. Finalize a result in the OE UI — verify `GET /fhir/facade/DiagnosticReport?patient={uuid}&status=final` returns the completed report
6. Stop the external HAPI Docker container entirely — verify all facade endpoints still respond correctly, confirming `clinlims` is the sole source of truth
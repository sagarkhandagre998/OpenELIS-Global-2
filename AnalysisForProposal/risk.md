# Risk Analysis and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Existing callers of `FhirPersistanceService` break when it is deleted | Medium | High | Grep all call sites before deletion; remove callers phase by phase, not all at once |
| `fhir_uuid` backfill Liquibase changeset is slow on large production databases | Medium | Medium | Run changeset with batch size limits; mark it `runOnChange="false"` so it only executes once at deployment |
| `TaskWorker` + `DBOrderPersister` have hidden coupling to the old polling context that breaks when called directly from `TaskProvider` | Medium | High | Trace all dependencies of `TaskWorker` before Phase 4; write a unit test that exercises `handleOrderRequest()` in isolation with mocks |
| Two providers accidentally assigned to the same FHIR resource type causing HAPI routing conflicts | Low | High | Each provider's `getResourceType()` is tested in its unit test; `FhirRestfulServer` startup fails fast if duplicates exist |
| Legacy `clinlims` rows with `NULL` `fhir_uuid` cause `NullPointerException` in provider read/search paths before backfill runs | Medium | High | Liquibase backfill runs in Phase 1 before any provider goes live; providers add a null-check guard and throw `InternalErrorException` if somehow still null |
| `LocationProvider` UUID lookup ambiguity — same UUID exists in both a storage table and `clinlims.organization` | Very Low | Medium | Lookup order is deterministic: storage tables checked first, organization fallback second; documented as a design invariant |
| Removing `SampleFhirTransformEventListener` breaks Odoo integration which listens on the same event | Medium | High | `SamplePatientUpdateDataCreatedEvent` and its Odoo listener are explicitly kept; only the FHIR sync listener is deleted |
| `EncounterProvider` `sample_encounter` table missing on a deployment that skips a Liquibase changeset | Low | Medium | Changeset is in the standard versioned Liquibase folder; startup validation catches missing tables before any request is served |
| Outbound FHIR referral push to remote labs breaks when `FhirUtil.getFhirClient()` is partially removed | Medium | High | Only `localFhirStorePath` config is removed; outbound client methods used for referrals are explicitly kept and covered by a unit test |
| Phase scope creep — building all 9 providers in one go makes the PR unreviewable | High | Medium | One provider per PR maximum; each PR is independently deployable behind the existing `InternalFhirApi` routing switch |
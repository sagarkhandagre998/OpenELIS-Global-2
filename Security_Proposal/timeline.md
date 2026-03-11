        Weeks  	               Task 	 Task To be Completed
   
   
     1 – 2 
  	  
           phase 1  
   Fix the Foundation
  	
✓ Build PatientProvider (@Read,@Search)
✓ Write unit test 
✓ InternalFhirApi: redirect GET /fhir/Patient/** → forwardToFacade
✓ SampleFhirTransformEventListener: remove patient sync call
 ✓ FhirTransformationController: remove patient batch loop


  
      2 - 3
	
              Phase 2 
     patientProvider build	  ✓ Build PatientProvider (@Create, @Read, @Update, @Search)
  ✓ Write unit test 
  ✓ InternalFhirApi: redirect GET /fhir/Patient/** → forwardToFacade
  ✓ SampleFhirTransformEventListener: remove patient sync call
  ✓ FhirTransformationController: remove patient batch loop

      3 - 6	               Phase  3
 Spicemen + ServiceRequest   
         + Observations 	 Build SpecimenProvider (@Create, @Read, @Search)
  ✓ Build ServiceRequestProvider (@Create, @Read, @Update, @Search)
  ✓ Build ObservationProvider (@Create, @Read, @Search)
  ✓ InternalFhirApi: redirect GETs for these types → forwardToFacade
  ✓ Remove corresponding sync calls from SampleFhirTransformEventListener
    6 - 10	               Phase  4
 Task + DiagnosticReport   	✓ Build TaskProvider (@Create, @Read, @Update, @Search)
  ✓ Build DiagnosticReportProvider (@Read, @Search — read-only)
  ✓ FhirApiWorkflowService.pollForRemoteTasks() DELETED
    (external systems now POST directly to /fhir/facade/Task)
  ✓ InternalFhirApi: all GETs now → forwardToFacade
  ✓ FhirTransformationController DELETED
  ✓ SampleFhirTransformEventListener DELETED
     10 - 11	           Phase  5
    LocationProvider	✓ Build `LocationProvider` with `@Read`, `@Search`, `@Create`, `@Update`, wiring up the existing `StorageLocationFhirTransform.
✓ Remove `syncToFhir()` calls from all five storage valueholders — facade replaces them
✓ Route Location GETs to the facade
✓ Integration tests including hierarchical queries

      11 - 12	         Phase  6
    EncounterProvider	✓ Liquibase changeset adding a `sample_encounter` table 
✓ Build `EncounterProvider` with `@Create`, `@Read`, `@Search`
✓Update both controllers to resolve encounters from the local facade instead of the remote server
✓ Integration tests
   12 - 13	         Phase  7
    OrganisationProvider	✓Build OrganizationProvider
✓ Integration tests
   13 - 14	        Phase 8 
    Final Avaluation 	 ✓ Delete `FhirPersistanceService` and its implementation .
 ✓ Remove the `transformPersistXxx` methods from `FhirTransformService`
  ✓ Delete `FhirExportController`, `RegisterFhirHooksTask`, `FhirQueryRestController`
 ✓ Remove `localFhirStorePath` from `FhirConfig`
 ✓  Mark the external HAPI Docker container as optional in `docker-compose.yml`
 ✓  Final cleanup of `InternalFhirApi` — all routes now go to the facade

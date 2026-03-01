External Systems in OpenELIS Global 2 — Detailed Breakdown

The architecture diagram shows **7 External Systems** on the left side. Here's a deep dive into each one based on the actual source code:

---

## 1. 🏥 EMR Systems — OpenMRS & iSantePlus (FHIR R4)

**What they are:** Electronic Medical Record systems — the primary "source of truth" for patient clinical data.

**Role in OpenELIS:**
- Send **electronic lab orders** to OpenELIS via FHIR R4 Tasks and ServiceRequests
- Receive **lab results** back from OpenELIS after testing is complete
- Drive the entire **Order → Sample → Result** workflow for eOrders

**How it works in code — `FhirApiWorkFlowServiceImpl.java`:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/fhir/service/FhirApiWorkFlowServiceImpl.java#L88-128
@Scheduled(initialDelay = 10 * 1000, fixedRateString = "${org.openelisglobal.remote.poll.frequency:120000}")
public void pollForRemoteTasks() {
    processWorkflow(ResourceType.Task);
}

@Async
public void processWorkflow(ResourceType resourceType) {
    for (String remoteStorePath : fhirConfig.getRemoteStorePaths()) {
        switch (resourceType) {
        case Task:
            beginTaskImportOrderPath(remoteStorePath);   // Pull new orders
            beginTaskCheckIfAcceptedPath(remoteStorePath); // Check acceptance
            beginTaskImportResultsPath(remoteStorePath);  // Import results
        }
    }
}
```

The scheduler **polls every 2 minutes** (configurable via `org.openelisglobal.remote.poll.frequency`) for new FHIR Tasks placed by OpenMRS/iSantePlus. It uses these 3 paths:
- **`beginTaskImportOrderPath`** — pulls FHIR Tasks with `status=REQUESTED` from the EMR
- **`beginTaskCheckIfAcceptedPath`** — updates accepted/rejected status back to the EMR
- **`beginTaskImportResultsPath`** — pushes results back as DiagnosticReports + Observations

**iSantePlus-specific identifiers** are handled in `StudyElectronicOrdersController.java`:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/order/controller/StudyElectronicOrdersController.java#L252-262
for (Identifier identifier : fhirPatient.getIdentifier()) {
    if (("https://openmrs.org/UPI").equals(identifier.getSystem())) {
        displayItem.setPatientUpid(identifier.getValue());
    }
    if (("http://fhir.openmrs.org/ext/patient/identifier#location")
            .equals(identifier.getExtensionFirstRep().getUrl())) {
        // location handling
    }
}
```

**Config properties used:** `org.openelisglobal.remote.source.uri`, `org.openelisglobal.remote.source.identifier`, `org.openelisglobal.remote.source.updateStatus`

---

## 2. 👤 Client Registry — OpenCR (FHIR R4)

**What it is:** A Master Patient Index (MPI) — a central registry that stores a unique patient record across all health systems.

**Role in OpenELIS:**
- Allows **patient search across facilities** — look up patients who exist in other hospitals
- Pushes **new patients** created in OpenELIS into the central registry
- Prevents duplicate patient records by checking for existing records before creating new ones

**How patient search works — `PatientSearchRestController.java`:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/common/rest/provider/PatientSearchRestController.java#L107-117
if (ConfigurationProperties.getInstance().getPropertyValue(Property.ENABLE_CLIENT_REGISTRY)
        .equals("true")) {
    String crSearchParam = request.getParameter("crSearch");
    if (crSearchParam != null && crSearchParam.contains("true")) {
        List<PatientSearchResults> fhirResults = searchPatientInClientRegistry(
            lastName, firstName, STNumber, subjectNumber, nationalID, null, guid, dateOfBirth, gender);
        results = fhirResults;
    }
}
```

**How patient sync works — `FhirTransformServiceImpl.java`:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/fhir/service/FhirTransformServiceImpl.java#L410-421
if (ConfigurationProperties.getInstance().getPropertyValue(Property.ENABLE_CLIENT_REGISTRY).equals("true")) {
    IGenericClient clientRegistry = fhirUtil.getFhirClient(
        fhirConfig.getClientRegistryServerUrl(),
        fhirConfig.getClientRegistryUserName(),
        fhirConfig.getClientRegistryPassword());
    if (isCreate) {
        clientRegistry.create().resource(patient).execute();
    } else {
        clientRegistry.update().resource(patient).execute();
    }
}
```

**Config properties:** `org.openelisglobal.crserver.uri`, `org.openelisglobal.crserver.username`, `org.openelisglobal.crserver.password`, and the toggle `enableClientRegistry` in site information.

---

## 3. 🏢 Facility Registry — GOFR (FHIR R4)

**What it is:** Global Open Facility Registry — a directory of health facilities (hospitals, clinics, labs).

**Role in OpenELIS:**
- Provides **Organization resources** representing health facilities
- OpenELIS registers itself as a FHIR `Organization` in the local FHIR store and syncs to remote servers
- Enables proper **facility identification** in FHIR messages (ServiceRequests, Tasks know which facility placed/handled them)

**How it works — `FhirFacilityOrganizationServiceImpl.java`:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/fhir/service/FhirFacilityOrganizationServiceImpl.java#L288-307
public void syncToLocalFhirServer() {
    String localFhirPath = fhirConfig.getLocalFhirStorePath();
    IGenericClient localFhirClient = fhirUtil.getFhirClient(localFhirPath);
    localFhirClient.update().resource(facilityOrganization).execute();
}

public void syncToRemoteFhirServers() {
    String[] remotePaths = fhirConfig.getRemoteStorePaths();
    for (String remotePath : remotePaths) {
        remoteFhirClient.update().resource(facilityOrganization).execute();
    }
}
```

OpenELIS auto-generates its own `Organization` FHIR resource (with its name, address, identifiers) and syncs it both locally and to any connected remote FHIR servers (like those belonging to EMRs or a national GOFR instance).

---

## 4. 🔀 HIE Mediator — OpenHIM (Routing, Audit)

**What it is:** Health Information Exchange — a middleware/router that sits between health systems and mediates/audits all messages.

**Role in OpenELIS:**
- Acts as a **routing layer** between OpenELIS and other systems (EMRs, registries)
- Provides an **audit trail** for all inter-system messages
- OpenELIS connects to it as though it were a FHIR server endpoint — the HIE transparently proxies requests

**How it's connected:**
The `ExternalConnection` entity supports multiple `ProgrammedConnection` types that map to OpenHIM-style connections:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/externalconnections/valueholder/ExternalConnection.java#L50-62
public enum ProgrammedConnection {
    SMPP_SERVER("smpp_server", "externalconnections.smppserver"),
    BMP_SMS_SERVER("bmp_sms_server", "externalconnections.bmpsms"),
    INFO_HIGHWAY("info_highway", "externalconnections.infohighway"),
    SMTP_SERVER("smtp_server", "externalconnections.smtpserver");
}
```

The `FhirConfig` `remoteStorePaths` configuration can point to an OpenHIM endpoint instead of directly to an EMR — OpenHIM then routes/logs those requests transparently.

**Auth options** (matching OpenHIM's supported auth types):

```OpenELIS-Global-2/src/main/java/org/openelisglobal/externalconnections/valueholder/ExternalConnection.java#L27-44
public enum AuthType {
    CERTIFICATE("certificate", "externalconnections.authtype.cert"),
    BASIC("basic", "externalconnections.authtype.basic"),
    NONE("none", "externalconnections.authtype.none");
}
```

---

## 5. 💰 Billing / ERP — Odoo (REST API)

**What it is:** Odoo is an open-source ERP system used for billing, invoicing, and financial management.

**Role in OpenELIS:**
- When a lab order (Sample) is created in OpenELIS, it **automatically creates an invoice** in Odoo
- Maps lab tests to **Odoo products/price lists**
- Looks up or creates **patient partners** (customers) in Odoo
- Provides billing integration so labs can charge for tests

**How it works — `OdooIntegrationService.java`:**

```OpenELIS-Global-2/src/main/java/org/openelisglobal/odoo/service/OdooIntegrationService.java#L54-73
public void createInvoice(SamplePatientUpdateData updateData) {
    if (!odooConnection.isAvailable()) {
        log.info("Odoo connection is not available. Skipping invoice creation for sample: {}",
                updateData.getAccessionNumber());
        return;
    }
    Map<String, Object> invoiceData = createInvoiceData(updateData);
    Integer invoiceId = odooConnection.create("account.move", List.of(invoiceData));
    log.info("Successfully created invoice in Odoo with ID: {} for sample: {}", invoiceId,
            updateData.getAccessionNumber());
}
```

The connection uses **XML-RPC** protocol (Odoo's native API). The `RealOdooClient` wraps the `OdooClient` and the `NoOpOdooClient` is a safe fallback when Odoo is not configured:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/odoo/client/RealOdooClient.java#L14-23
public RealOdooClient(OdooClient odooClient) {
    this.odooClient = odooClient;
    try {
        odooClient.init();
        available = true;
        log.info("Successfully connected to Odoo at startup.");
    } catch (Exception e) {
        available = false;
        log.error("Failed to connect to Odoo at startup: {}", e.getMessage(), e);
    }
}
```

A **test-to-product mapping** (`TestProductMapping`) maps LOINC codes or test names to Odoo product entries with price and quantity.

---

## 6. 📊 Surveillance — DHIS2 & SORMAS (FHIR R4)

**What they are:**
- **DHIS2** (District Health Information Software 2) — national public health aggregate reporting platform
- **SORMAS** (Surveillance Outbreak Response Management and Analysis System) — disease outbreak tracking

**Role in OpenELIS:**
There are **two surveillance reporting flows**:

### A) Aggregate Reporting (DHIS2-style) — `AggregateReportJob.java`
Scheduled job that sends **aggregate lab indicator reports** (test counts, positivity rates) to a surveillance endpoint:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/aggregatereporting/AggregateReportJob.java#L66-91
List<ReportExternalExport> sendableReports = reportExternalExportService
        .getUnsentReportExports(LAB_INDICATOR_REPORT_ID);
String url = ConfigurationProperties.getInstance()
        .getPropertyValue(Property.testUsageReportingURL) + "/IndicatorAggregation";
new ReportTransmission().sendReport(wrapper, castorPropertyName, url, false, responseHandler);
```

### B) Malaria Surveillance (SORMAS-style) — `MalariaSurveilanceJob.java`
Scheduled job specifically for malaria case reporting:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/dataexchange/MalariaSurveilance/MalariaSurveilanceJob.java#L169-177
String url = ConfigurationProperties.getInstance()
        .getPropertyValue(Property.malariaSurveillanceReportURL);
new ReportTransmission().sendRawReport(buffer.toString(), url, sendAsychronously,
        responseHandler, HTTP_TYPE.POST);
```

**Config properties:** `testUsageReporting`, `testUsageReportingURL`, `malariaSurveillanceReport`, `malariaSurveillanceReportURL`, `malariaCaseReport`, `malariaCaseReportURL`

---

## 7. 📈 Analytics — Superset & Grafana

**What they are:**
- **Apache Superset** — business intelligence/data visualization tool
- **Grafana** — metrics and time-series dashboards (often paired with Prometheus)

**Role in OpenELIS:**
These are **read-only consumers** of OpenELIS data. They connect directly to the PostgreSQL database or via the metrics API endpoint:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/config/AnnotationWebAppInitializer.java#L103-106
ServletRegistration.Dynamic metricServicesServlet = ...;
metricServicesServlet.addMapping("/MetricServices");
```

The `MetricService` package provides a REST endpoint that exposes lab KPIs (turnaround times, test volumes, QC metrics) which Superset/Grafana can poll. Superset can also be given direct read-only DB access to the `clinlims` schema for custom SQL-based dashboards.

---

## Summary Table

| External System | Protocol | Direction | Key Package |
|---|---|---|---|
| **OpenMRS / iSantePlus** | FHIR R4 Task/ServiceRequest | Bidirectional | `dataexchange/fhir/service/` |
| **OpenCR** (Client Registry) | FHIR R4 Patient | Bidirectional | `PatientSearchRestController`, `FhirTransformServiceImpl` |
| **GOFR** (Facility Registry) | FHIR R4 Organization | Outbound | `FhirFacilityOrganizationServiceImpl` |
| **OpenHIM** (HIE) | HTTP/FHIR (proxy) | Bidirectional | `externalconnections/` |
| **Odoo** (Billing) | XML-RPC / REST | Outbound | `odoo/` |
| **DHIS2 / SORMAS** (Surveillance) | HTTP/XML | Outbound | `dataexchange/aggregatereporting/`, `dataexchange/MalariaSurveilance/` |
| **Superset / Grafana** (Analytics) | SQL / REST Metrics | Inbound (read) | `metricservice/` |

All external integrations are **configuration-driven** — they are toggled on/off via site information properties, and connection URLs/credentials are stored in the database or `application.properties`, never hardcoded. This ensures the same codebase works across all deployment contexts without country-specific forks.
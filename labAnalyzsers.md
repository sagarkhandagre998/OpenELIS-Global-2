Lab Analyzers in OpenELIS-Global-2 — In-Depth Breakdown

The **Lab Analyzer** subsystem is one of the most sophisticated parts of OpenELIS. It bridges the gap between physical laboratory machines (GeneXpert, Sysmex XN/XP, Cobas Series, etc.) and the LIMS software. Here's a complete breakdown:

---

## 1. What Are Lab Analyzers?

Lab analyzers are **physical laboratory instruments** that run tests on patient samples (blood, urine, etc.) and produce results electronically. OpenELIS must:
- **Receive** results from analyzers automatically (no manual entry)
- **Send** test orders to analyzers (bidirectional)
- **Map** analyzer-specific field codes to OpenELIS concepts (tests, panels, results)
- **Handle errors** when messages fail to parse or map

---

## 2. Supported Analyzers (from the `plugins/analyzers/` directory)

Each analyzer is packaged as a **plugin JAR**:

| Analyzer | Type | Protocol |
|---|---|---|
| **GeneXpert** | Molecular/PCR | ASTM / HL7 |
| **Sysmex XN/XP** | Hematology | ASTM LIS2-A2 |
| **Cobas C111, Cobas Integra 400, Cobas TaqMan 48 DBS** | Chemistry / PCR | ASTM / HL7 |
| **FACSCalibur, FACSCantoII, FACSPresto** | Flow Cytometry | File/CSV |
| **SysmeXT, Fully** | Hematology/Chemistry | ASTM |

---

## 3. Communication Protocols Supported

Defined in `ProtocolVersion.java`:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/analyzer/valueholder/ProtocolVersion.java#L19-30
/** ASTM / CLSI LIS2-A2 pipe-delimited record format. */
ASTM_LIS2_A2("ASTM LIS2-A2"),

/** HL7 v2.3.1 segment-based messaging. */
HL7_V2_3_1("HL7 v2.3.1"),

/** HL7 v2.5 segment-based messaging. */
HL7_V2_5("HL7 v2.5");
```

### Transport Mechanisms (3 modes):
| Transport | How It Works |
|---|---|
| **TCP/IP** | Analyzer connects over the network via IP:Port |
| **RS-232 Serial** | Physical cable connection (legacy analyzers) |
| **File Import** | Analyzer exports a CSV/flat file, OpenELIS watches a folder |

---

## 4. The `Analyzer` Entity (Core Data Model)

Defined in `Analyzer.java`, every registered analyzer tracks:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/analyzer/valueholder/Analyzer.java#L61-110
private String name;
private String machineId;
private String type;
private String ipAddress;       // TCP transport
private Integer port;
private ProtocolVersion protocolVersion;  // ASTM or HL7
private AnalyzerStatus status;  // Lifecycle state
private List<String> testUnitIds;
private String identifierPattern;
```

### Analyzer Lifecycle States:
```OpenELIS-Global-2/src/main/java/org/openelisglobal/analyzer/valueholder/Analyzer.java#L191-194
public enum AnalyzerStatus {
    INACTIVE, SETUP, VALIDATION, ACTIVE, ERROR_PENDING, OFFLINE, DELETED
}
```

The lifecycle is event-driven (from `AnalyzerStatusTransitionService`):

```
SETUP → VALIDATION  (first mapping created)
VALIDATION → ACTIVE  (all required mappings activated)
ACTIVE → ERROR_PENDING  (unacknowledged error exists)
ACTIVE → OFFLINE  (connection test fails or 7 days inactive)
ERROR_PENDING → ACTIVE  (all errors acknowledged)
OFFLINE → ACTIVE  (connection restored)
```

---

## 5. The 3-Layer Message Processing Pipeline

When an analyzer sends a message, it flows through this pipeline:

### Step 1 — Message Arrival
- **ASTM TCP**: The `AnalyzerRestController` listens. ENQ/ACK handshake happens (`byte ENQ = 0x05`, `byte ACK = 0x06`)
- **HL7**: The `HL7MessageService` parses `ORU^R01` result messages and generates `ORM^O01` orders
- **Serial/RS-232**: The `SerialPortService` manages port connections (baud rate, parity, stop bits)
- **File**: The `FileImportWatchService` monitors a directory for new files

### Step 2 — Mapping Application (`MappingAwareAnalyzerLineInserter`)
This is the **heart of the system**:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/analyzer/service/MappingAwareAnalyzerLineInserter.java#L64-100
if (!mappingApplicationService.hasActiveMappings(analyzer.getId())) {
    // No mappings configured - delegate to original inserter (backward compatibility)
    return originalInserter.insert(lines, currentUserId);
}

MappingApplicationResult result = mappingApplicationService.applyMappings(analyzer.getId(), lines);

if (!result.isSuccess()) {
    String errorMessage = "Failed to apply mappings: " + ...;
    createError(errorMessage, lines);
    return false;
}
```

### Step 3 — Plugin Inserter (per-analyzer logic)
Each analyzer plugin implements `AnalyzerLineInserter`. For example, the Cobas C111:

```OpenELIS-Global-2/plugins/analyzers/CobasC111/src/oe/plugin/analyzer/CobasC111AnalyzerImplementation.java#L67-90
testNameMap.put("GLU2", new TestDAOImpl().getTestByName("Glucose"));
testNameMap.put("CREJ2", new TestDAOImpl().getTestByName("Créatinine"));
testNameMap.put("ALTL", new TestDAOImpl().getTestByName("Transaminases GPT (37°C)"));
```

It parses the raw lines and creates `AnalyzerResults` objects that get persisted.

---

## 6. Field Mapping System

This is the **configurable mapping engine** mentioned as "Configurable Mapping" in the architecture diagram.

### `AnalyzerField` — What the analyzer emits:
```OpenELIS-Global-2/src/main/java/org/openelisglobal/analyzer/valueholder/AnalyzerField.java#L79-87
public enum FieldType {
    NUMERIC, QUALITATIVE, CONTROL_TEST, MELTING_POINT, DATE_TIME, TEXT, CUSTOM
}
```

### `AnalyzerFieldMapping` — Maps analyzer fields → OpenELIS entities:
```OpenELIS-Global-2/src/main/java/org/openelisglobal/analyzer/valueholder/AnalyzerFieldMapping.java#L148-157
public enum OpenELISFieldType {
    TEST, PANEL, RESULT, ORDER, SAMPLE, QC, METADATA, UNIT
}

public enum MappingType {
    TEST_LEVEL, RESULT_LEVEL, METADATA
}
```

**Required mappings** (must exist before an analyzer can go ACTIVE):
- Sample ID
- Test Code
- Result Value

The `AnalyzerFieldMappingService` supports a **draft → activate workflow**, bulk activation, type-compatibility validation, and audit trail logging.

---

## 7. QC (Quality Control) Processing

When the analyzer sends **Q-segments** (quality control data) in an ASTM message, they are parsed by `ASTMQSegmentParser`:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/analyzer/service/ASTMQSegmentParser.java#L35-41
/**
 * Q-segment format:
 * Q|sequence|test_code^control_lot^control_level|result_value|unit|timestamp|flag
 */
```

QC results are processed **within the same transaction** as patient results (FR-021) via `QCResultProcessingService`.

---

## 8. Error Handling & Dashboard

When a message fails, an `AnalyzerError` is created:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/analyzer/valueholder/AnalyzerError.java#L94-108
public enum ErrorType {
    MAPPING, VALIDATION, TIMEOUT, PROTOCOL, CONNECTION,
    QC_MAPPING_INCOMPLETE, QC_SERVICE_UNAVAILABLE
}

public enum Severity {
    CRITICAL, ERROR, WARNING
}

public enum ErrorStatus {
    UNACKNOWLEDGED, ACKNOWLEDGED, RESOLVED
}
```

The `AnalyzerErrorRestController` exposes a **REST API** (`/rest/analyzer/errors`) for:
- Listing errors with filtering
- Acknowledging errors
- **Reprocessing** — after a mapping is created, you can replay the failed raw ASTM message through the pipeline again via `AnalyzerReprocessingService`

---

## 9. Bidirectional Communication

Represented in the diagram as **"↔ Bidirectional"**. The `BidirectionalAnalyzer` interface allows OpenELIS to **send orders to the analyzer** (not just receive results):

```OpenELIS-Global-2/src/main/java/org/openelisglobal/analyzer/service/BidirectionalAnalyzer.java#L11-20
List<LISAction> getSupportedLISActions();
boolean runLISAction(String actionName, Map<String, String> actionParameters);
```

The `HL7MessageService` generates `ORM^O01` order messages that OpenELIS sends back to the analyzer over TCP.

---

## 10. Lifecycle Scheduling

The `AnalyzerLifecycleScheduler` runs **daily at 2 AM** and transitions any analyzer that has been `ACTIVE` for more than 7 days without activity to `OFFLINE`:

```OpenELIS-Global-2/src/main/java/org/openelisglobal/analyzer/service/AnalyzerLifecycleScheduler.java#L46-48
@Scheduled(cron = "0 0 2 * * ?")
@Transactional
public void transitionToMaintenance() {
```

---

## Summary: Full Flow Diagram

```/dev/null/flow.txt#L1-20
Physical Analyzer (GeneXpert / Sysmex / Cobas)
        │
        │  ASTM LIS2-A2 / HL7 v2.x over:
        │  ┌── TCP/IP (IP:Port)
        │  ├── RS-232 Serial Port
        │  └── File Drop (CSV/flat file)
        ↓
  AnalyzerRestController  ←→  openelis-analyzer-bridge (Docker)
        │
        ↓
  MappingAwareAnalyzerLineInserter
        │
        ├── applyMappings()  → AnalyzerFieldMapping table
        │       ↓ success
        ├── Plugin AnalyzerLineInserter (CobasC111, Sysmex, etc.)
        │       ↓
        ├── AnalyzerResults → PostgreSQL DB
        │
        ├── processQCSegments() → QCResultProcessingService
        │
        └── on failure → AnalyzerError (MAPPING / PROTOCOL / etc.)
                              ↓ later
                         Reprocessing via AnalyzerErrorRestController
```

The key insight is that the system is **protocol-agnostic and configuration-driven** — you never fork code for a new analyzer type. Instead, you:
1. Register the analyzer
2. Configure the transport (TCP/serial/file)
3. Define field mappings in the UI
4. Activate → the analyzer becomes `ACTIVE` and results flow in automatically
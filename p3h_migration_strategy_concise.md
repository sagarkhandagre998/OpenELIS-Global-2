# P3-H — sysUserId "1" Migration Strategy

## The Problem
- 40+ call sites hardcode `setSysUserId("1")` across schedulers, REST controllers, plugin loaders, and FHIR services
- The `history` table already has rows attributed to `"1"` — these are ambiguous between real admin actions and background system jobs
- A code-only fix addresses future entries but leaves existing history broken

---

## Call Site Categories

| Category | Files | Fix |
|----------|-------|-----|
| Interactive / REST | `LogoUploadServiceImpl`, `StorageLocationRestController` | `SecurityContextHolder` |
| Scheduled jobs | `MalariaSurveilanceJob`, `AggregateReportJob`, `ResultReportingTransfer` | `SYSTEM_SCHEDULER` account |
| Startup / config | `DictionaryConfigurationHandler`, `RolesConfigurationHandler`, `TestConfigurationHandler` | `SYSTEM_BOOTSTRAP` account |
| Plugin registration | `PluginRegistryService`, `PluginAnalyzerService`, `AnalyzerServiceImpl` | `SYSTEM_PLUGIN` account |
| FHIR / referral | `FhirReferralServiceImpl`, `ReferralSetServiceImpl` | `SYSTEM_FHIR` account |

---

## Migration Steps

**Step 1 — Liquibase: create named system accounts (before any code change)**
- Insert 4 non-login service accounts: `SYSTEM_SCHEDULER`, `SYSTEM_BOOTSTRAP`, `SYSTEM_PLUGIN`, `SYSTEM_FHIR`
- `account_disabled = Y` — these accounts cannot log in, they only exist for audit attribution
- Store their generated IDs in `application.properties`

**Step 2 — Reclassify existing history rows**
- Run a one-time Liquibase changeset to update `history` rows where `sys_user_id = '1'`
- Use table name heuristics: `dictionary`, `role`, `test` → `SYSTEM_BOOTSTRAP`; `cron_scheduler`, `report_external_export` → `SYSTEM_SCHEDULER`
- Rows that cannot be reclassified (genuinely ambiguous) stay as `"1"` — documented in PR, not guessed

**Step 3 — Code fix**
- Interactive paths: replace `"1"` with `SecurityUtil.getCurrentSysUserId()` backed by `SecurityContextHolder`
- Background jobs: inject `@Value("${system.userId.scheduler}")` and use that
- Config loaders: inject `@Value("${system.userId.bootstrap}")` and use that

---

## PR Sequence

| Order | PR |
|-------|----|
| 1st | Liquibase: create 4 system accounts + `application.properties` keys |
| 2nd | Liquibase: reclassification query for existing history rows |
| 3rd | Code: replace all 40+ `setSysUserId("1")` call sites |

> PR 3 must not merge before PR 1 is deployed — the property keys the code reads must exist in the DB first.

---

## What Is Not Fixed
- History rows that are genuinely ambiguous (could be real admin or system) cannot be reclassified without fabricating attribution — they stay as `"1"` and are noted as a pre-existing gap, not a regression
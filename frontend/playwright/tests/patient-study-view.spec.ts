import { test, expect } from "@playwright/test";
import { UI_TIMEOUT, SHORT_TIMEOUT, LONG_TIMEOUT } from "../helpers/timeouts";

/**
 * Patient Study View & Edit — Playwright E2E
 *
 * Covers the React migration of Patient → Study → View and Patient → Study → Edit.
 * Tests are structured around the page-object pattern used by the rest of the suite.
 *
 * Auth: uses the shared storageState from auth.setup.ts (no login steps here).
 *
 * Network strategy: intercept REST calls to avoid dependency on seeded DB data
 * for UI-shape assertions; full-chain assertions (row selection, form load) rely
 * on the mock responses injected via page.route().
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared mock data
// ─────────────────────────────────────────────────────────────────────────────

const MOCK_PATIENT = {
  patientPK: "42",
  lastName: "Dupont",
  firstName: "Marie",
  gender: "F",
  birthDateForDisplay: "01/01/1985",
  nationalId: "NID-0042",
  subjectNumber: "SUB-042",
  siteSubjectNumber: "SITE-042",
  stNumber: "ST-042",
};

const MOCK_SEARCH_RESPONSE = {
  patients: [MOCK_PATIENT],
};

const MOCK_STUDY_FORM = {
  patientPK: "42",
  samplePK: "99",
  projectFormName: "InitialARV_Id",
  lastName: "Dupont",
  firstName: "Marie",
  gender: "F",
  birthDateForDisplay: "01/01/1985",
  subjectNumber: "SUB-042",
  siteSubjectNumber: "SITE-042",
  labNo: "LAB-099",
  receivedDateForDisplay: "10/06/2024",
  interviewDate: "10/06/2024",
  centerName: "1",
  centerCode: "1",
  age: "39",
  observations: {
    hivStatus: "1",
    educationLevel: "",
    maritalStatus: "",
    nationality: "",
    nameOfDoctor: "Dr. Test",
    patientWeight: "65",
    karnofskyScore: "90",
    underInvestigation: "false",
  },
  projectData: {
    underInvestigationNote: "",
  },
  availableStudyForms: ["InitialARV_Id"],
  lists: {
    arvOrgs: [{ id: "1", value: "Centre A" }],
    arvOrgsByName: [{ id: "1", organizationName: "Centre A" }],
    hivStatuses: [{ id: "1", value: "Positif" }],
    educationLevels: [],
    maritalStatuses: [],
    nationalities: [],
    yesNo: [
      { id: "true", value: "Oui" },
      { id: "false", value: "Non" },
    ],
    yesNoNa: [],
    yesNoUnknownNaNotSpec: [],
    aidsStages: [],
    arvProphylaxis: [],
    priorDiseasesList: [],
    currentDiseasesList: [],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function interceptSearch(page: any) {
  await page.route("**/rest/patient-search-for-study**", async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_SEARCH_RESPONSE),
    });
  });
}

async function interceptStudyView(page: any) {
  await page.route(
    "**/rest/patient-study-view**",
    async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_STUDY_FORM),
      });
    },
  );
}

async function interceptStudyEdit(page: any) {
  await page.route(
    "**/rest/patient-study-view**",
    async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_STUDY_FORM),
      });
    },
  );
  await page.route("**/rest/patient-study-edit", async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true }),
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Patient Study View
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Patient Study View", () => {
  test("page loads and renders the search section", async ({ page }) => {
    await interceptSearch(page);
    await page.goto("/PatientStudyView");

    await expect(page.locator("#searchCriteria")).toBeVisible({
      timeout: UI_TIMEOUT,
    });
    await expect(page.locator("#patientSearchValue")).toBeVisible({
      timeout: SHORT_TIMEOUT,
    });
    await expect(page.locator("#patientSearchButton")).toBeVisible({
      timeout: SHORT_TIMEOUT,
    });
  });

  test("search criteria dropdown has 5 options plus placeholder", async ({
    page,
  }) => {
    await interceptSearch(page);
    await page.goto("/PatientStudyView");

    const select = page.locator("#searchCriteria");
    await expect(select).toBeVisible({ timeout: UI_TIMEOUT });
    const options = select.locator("option");
    await expect(options).toHaveCount(6, { timeout: SHORT_TIMEOUT });
  });

  test("results table and view button are not shown before search", async ({
    page,
  }) => {
    await page.goto("/PatientStudyView");

    await expect(page.locator(".cds--data-table")).toBeHidden({
      timeout: SHORT_TIMEOUT,
    });
    await expect(page.locator("#viewPatientButton")).toBeHidden({
      timeout: SHORT_TIMEOUT,
    });
  });

  test("shows notification when Search clicked without selecting criteria", async ({
    page,
  }) => {
    await page.goto("/PatientStudyView");
    await page.locator("#patientSearchButton").click();

    await expect(
      page.locator(".cds--actionable-notification, .cds--toast-notification"),
    ).toBeVisible({ timeout: UI_TIMEOUT });
  });

  test("shows notification when Search clicked with empty search value", async ({
    page,
  }) => {
    await page.goto("/PatientStudyView");
    await page.locator("#searchCriteria").selectOption("2");
    await page.locator("#patientSearchButton").click();

    await expect(
      page.locator(".cds--actionable-notification, .cds--toast-notification"),
    ).toBeVisible({ timeout: UI_TIMEOUT });
  });

  test("Enter key in search input triggers search", async ({ page }) => {
    await interceptSearch(page);
    await page.goto("/PatientStudyView");

    await page.locator("#searchCriteria").selectOption("2");
    await page.locator("#patientSearchValue").fill("Dupont");
    await page.locator("#patientSearchValue").press("Enter");

    await expect(
      page.locator(".cds--data-table, .cds--actionable-notification, .cds--toast-notification"),
    ).toBeVisible({ timeout: UI_TIMEOUT });
  });

  test("search returns results table with correct column headers", async ({
    page,
  }) => {
    await interceptSearch(page);
    await page.goto("/PatientStudyView");

    await page.locator("#searchCriteria").selectOption("2");
    await page.locator("#patientSearchValue").fill("Dupont");
    await page.locator("#patientSearchButton").click();

    const table = page.locator(".cds--data-table");
    await expect(table).toBeVisible({ timeout: UI_TIMEOUT });

    await expect(table.getByRole("columnheader", { name: "Last Name" })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "First Name" })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "Gender" })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "Date of Birth" })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "National ID" })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "Subject Number" })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "ST Number" })).toBeVisible();
  });

  test("search returns at least one patient row from mock", async ({
    page,
  }) => {
    await interceptSearch(page);
    await page.goto("/PatientStudyView");

    await page.locator("#searchCriteria").selectOption("2");
    await page.locator("#patientSearchValue").fill("Dupont");
    await page.locator("#patientSearchButton").click();

    await expect(page.locator(".cds--data-table tbody tr")).toHaveCount(1, {
      timeout: UI_TIMEOUT,
    });
    await expect(
      page.locator(".cds--data-table tbody tr").first(),
    ).toContainText("Dupont");
  });

  test("View Patient Study button is visible but disabled before row selection", async ({
    page,
  }) => {
    await interceptSearch(page);
    await page.goto("/PatientStudyView");

    await page.locator("#searchCriteria").selectOption("2");
    await page.locator("#patientSearchValue").fill("Dupont");
    await page.locator("#patientSearchButton").click();

    await expect(page.locator(".cds--data-table")).toBeVisible({
      timeout: UI_TIMEOUT,
    });
    await expect(page.locator("#viewPatientButton")).toBeVisible();
    await expect(page.locator("#viewPatientButton")).toBeDisabled();
  });

  test("clicking a result row enables the View Patient Study button", async ({
    page,
  }) => {
    await interceptSearch(page);
    await page.goto("/PatientStudyView");

    await page.locator("#searchCriteria").selectOption("2");
    await page.locator("#patientSearchValue").fill("Dupont");
    await page.locator("#patientSearchButton").click();

    await expect(page.locator(".cds--data-table tbody tr")).toBeVisible({
      timeout: UI_TIMEOUT,
    });
    await page.locator(".cds--data-table tbody tr").first().click();

    await expect(page.locator("#viewPatientButton")).toBeEnabled({
      timeout: SHORT_TIMEOUT,
    });
  });

  test("clicking a row does NOT auto-load the study form", async ({ page }) => {
    await interceptSearch(page);
    await page.goto("/PatientStudyView");

    await page.locator("#searchCriteria").selectOption("2");
    await page.locator("#patientSearchValue").fill("Dupont");
    await page.locator("#patientSearchButton").click();

    await expect(page.locator(".cds--data-table tbody tr")).toBeVisible({
      timeout: UI_TIMEOUT,
    });
    await page.locator(".cds--data-table tbody tr").first().click();

    await expect(page.locator("#studyTypeSelector")).toBeHidden({
      timeout: SHORT_TIMEOUT,
    });
  });

  test("clicking View Patient Study loads the study form", async ({ page }) => {
    await interceptSearch(page);
    await interceptStudyView(page);
    await page.goto("/PatientStudyView");

    await page.locator("#searchCriteria").selectOption("2");
    await page.locator("#patientSearchValue").fill("Dupont");
    await page.locator("#patientSearchButton").click();

    await expect(page.locator(".cds--data-table tbody tr")).toBeVisible({
      timeout: UI_TIMEOUT,
    });
    await page.locator(".cds--data-table tbody tr").first().click();
    await page.locator("#viewPatientButton").click();

    await expect(page.locator("#studyTypeSelector")).toBeVisible({
      timeout: LONG_TIMEOUT,
    });
  });

  test("patient banner is shown after form loads", async ({ page }) => {
    await interceptSearch(page);
    await interceptStudyView(page);
    await page.goto("/PatientStudyView");

    await page.locator("#searchCriteria").selectOption("2");
    await page.locator("#patientSearchValue").fill("Dupont");
    await page.locator("#patientSearchButton").click();
    await expect(page.locator(".cds--data-table tbody tr")).toBeVisible({
      timeout: UI_TIMEOUT,
    });
    await page.locator(".cds--data-table tbody tr").first().click();
    await page.locator("#viewPatientButton").click();

    await expect(page.getByTestId("patient-banner")).toBeVisible({
      timeout: LONG_TIMEOUT,
    });
  });

  test("study type selector is enabled and auto-selects a value", async ({
    page,
  }) => {
    await interceptSearch(page);
    await interceptStudyView(page);
    await page.goto("/PatientStudyView");

    await page.locator("#searchCriteria").selectOption("2");
    await page.locator("#patientSearchValue").fill("Dupont");
    await page.locator("#patientSearchButton").click();
    await expect(page.locator(".cds--data-table tbody tr")).toBeVisible({
      timeout: UI_TIMEOUT,
    });
    await page.locator(".cds--data-table tbody tr").first().click();
    await page.locator("#viewPatientButton").click();

    await expect(page.locator("#studyTypeSelector")).toBeEnabled({
      timeout: LONG_TIMEOUT,
    });
    const selected = page.locator("#studyTypeSelector option:checked");
    await expect(selected).not.toHaveValue("");
  });

  test("Patient Information section is rendered with read-only fields", async ({
    page,
  }) => {
    await interceptSearch(page);
    await interceptStudyView(page);
    await page.goto("/PatientStudyView");

    await page.locator("#searchCriteria").selectOption("2");
    await page.locator("#patientSearchValue").fill("Dupont");
    await page.locator("#patientSearchButton").click();
    await expect(page.locator(".cds--data-table tbody tr")).toBeVisible({
      timeout: UI_TIMEOUT,
    });
    await page.locator(".cds--data-table tbody tr").first().click();
    await page.locator("#viewPatientButton").click();

    await expect(page.locator("#studyTypeSelector")).toBeVisible({
      timeout: LONG_TIMEOUT,
    });
    await expect(page.getByText("Patient Information")).toBeVisible();
    await expect(page.locator("input[readonly]").first()).toBeVisible();
  });

  test("family name field shows the patient last name from mock", async ({
    page,
  }) => {
    await interceptSearch(page);
    await interceptStudyView(page);
    await page.goto("/PatientStudyView");

    await page.locator("#searchCriteria").selectOption("2");
    await page.locator("#patientSearchValue").fill("Dupont");
    await page.locator("#patientSearchButton").click();
    await expect(page.locator(".cds--data-table tbody tr")).toBeVisible({
      timeout: UI_TIMEOUT,
    });
    await page.locator(".cds--data-table tbody tr").first().click();
    await page.locator("#viewPatientButton").click();

    await expect(page.locator("#studyTypeSelector")).toBeVisible({
      timeout: LONG_TIMEOUT,
    });
    // The family name TextInput has id matching the labelId
    const familyNameInput = page.locator(
      "input[id='patient.project.patientFamilyName']",
    );
    await expect(familyNameInput).toHaveValue("Dupont");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Patient Study Edit
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Patient Study Edit", () => {
  test("page loads and renders the search section", async ({ page }) => {
    await interceptSearch(page);
    await page.goto("/PatientStudyEdit");

    await expect(page.locator("#searchCriteria")).toBeVisible({
      timeout: UI_TIMEOUT,
    });
    await expect(page.locator("#patientSearchValue")).toBeVisible({
      timeout: SHORT_TIMEOUT,
    });
    await expect(page.locator("#patientSearchButton")).toBeVisible({
      timeout: SHORT_TIMEOUT,
    });
  });

  test("shows notification when Search clicked without selecting criteria", async ({
    page,
  }) => {
    await page.goto("/PatientStudyEdit");
    await page.locator("#patientSearchButton").click();

    await expect(
      page.locator(".cds--actionable-notification, .cds--toast-notification"),
    ).toBeVisible({ timeout: UI_TIMEOUT });
  });

  test("search returns results and Edit Patient Study button is disabled before row selection", async ({
    page,
  }) => {
    await interceptSearch(page);
    await page.goto("/PatientStudyEdit");

    await page.locator("#searchCriteria").selectOption("2");
    await page.locator("#patientSearchValue").fill("Dupont");
    await page.locator("#patientSearchButton").click();

    await expect(page.locator(".cds--data-table")).toBeVisible({
      timeout: UI_TIMEOUT,
    });
    await expect(page.locator("#editPatientButton")).toBeVisible();
    await expect(page.locator("#editPatientButton")).toBeDisabled();
  });

  test("clicking a result row enables the Edit Patient Study button", async ({
    page,
  }) => {
    await interceptSearch(page);
    await page.goto("/PatientStudyEdit");

    await page.locator("#searchCriteria").selectOption("2");
    await page.locator("#patientSearchValue").fill("Dupont");
    await page.locator("#patientSearchButton").click();

    await expect(page.locator(".cds--data-table tbody tr")).toBeVisible({
      timeout: UI_TIMEOUT,
    });
    await page.locator(".cds--data-table tbody tr").first().click();

    await expect(page.locator("#editPatientButton")).toBeEnabled({
      timeout: SHORT_TIMEOUT,
    });
  });

  test("clicking Edit Patient Study loads the editable form", async ({
    page,
  }) => {
    await interceptSearch(page);
    await interceptStudyEdit(page);
    await page.goto("/PatientStudyEdit");

    await page.locator("#searchCriteria").selectOption("2");
    await page.locator("#patientSearchValue").fill("Dupont");
    await page.locator("#patientSearchButton").click();
    await expect(page.locator(".cds--data-table tbody tr")).toBeVisible({
      timeout: UI_TIMEOUT,
    });
    await page.locator(".cds--data-table tbody tr").first().click();
    await page.locator("#editPatientButton").click();

    await expect(page.locator("#studyTypeSelector")).toBeVisible({
      timeout: LONG_TIMEOUT,
    });
  });

  test("patient banner is shown after edit form loads", async ({ page }) => {
    await interceptSearch(page);
    await interceptStudyEdit(page);
    await page.goto("/PatientStudyEdit");

    await page.locator("#searchCriteria").selectOption("2");
    await page.locator("#patientSearchValue").fill("Dupont");
    await page.locator("#patientSearchButton").click();
    await expect(page.locator(".cds--data-table tbody tr")).toBeVisible({
      timeout: UI_TIMEOUT,
    });
    await page.locator(".cds--data-table tbody tr").first().click();
    await page.locator("#editPatientButton").click();

    await expect(page.getByTestId("patient-edit-banner")).toBeVisible({
      timeout: LONG_TIMEOUT,
    });
  });

  test("demographic fields are editable (not read-only)", async ({ page }) => {
    await interceptSearch(page);
    await interceptStudyEdit(page);
    await page.goto("/PatientStudyEdit");

    await page.locator("#searchCriteria").selectOption("2");
    await page.locator("#patientSearchValue").fill("Dupont");
    await page.locator("#patientSearchButton").click();
    await expect(page.locator(".cds--data-table tbody tr")).toBeVisible({
      timeout: UI_TIMEOUT,
    });
    await page.locator(".cds--data-table tbody tr").first().click();
    await page.locator("#editPatientButton").click();

    await expect(page.locator("#studyTypeSelector")).toBeVisible({
      timeout: LONG_TIMEOUT,
    });
    await expect(page.locator("#lastName")).toBeVisible();
    await expect(page.locator("#lastName")).not.toHaveAttribute("readonly");
  });

  test("Save and Cancel buttons are present in the edit form", async ({
    page,
  }) => {
    await interceptSearch(page);
    await interceptStudyEdit(page);
    await page.goto("/PatientStudyEdit");

    await page.locator("#searchCriteria").selectOption("2");
    await page.locator("#patientSearchValue").fill("Dupont");
    await page.locator("#patientSearchButton").click();
    await expect(page.locator(".cds--data-table tbody tr")).toBeVisible({
      timeout: UI_TIMEOUT,
    });
    await page.locator(".cds--data-table tbody tr").first().click();
    await page.locator("#editPatientButton").click();

    await expect(page.locator("#studyTypeSelector")).toBeVisible({
      timeout: LONG_TIMEOUT,
    });
    await expect(page.locator("#savePatientStudyButton")).toBeVisible();
    await expect(page.locator("#cancelPatientStudyButton")).toBeVisible();
  });

  test("Save calls the REST endpoint and shows success notification", async ({
    page,
  }) => {
    await interceptSearch(page);
    await interceptStudyEdit(page);
    await page.goto("/PatientStudyEdit");

    await page.locator("#searchCriteria").selectOption("2");
    await page.locator("#patientSearchValue").fill("Dupont");
    await page.locator("#patientSearchButton").click();
    await expect(page.locator(".cds--data-table tbody tr")).toBeVisible({
      timeout: UI_TIMEOUT,
    });
    await page.locator(".cds--data-table tbody tr").first().click();
    await page.locator("#editPatientButton").click();

    await expect(page.locator("#studyTypeSelector")).toBeVisible({
      timeout: LONG_TIMEOUT,
    });

    const [saveRequest] = await Promise.all([
      page.waitForRequest(
        (req) =>
          req.url().includes("patient-study-edit") &&
          req.method() === "POST",
      ),
      page.locator("#savePatientStudyButton").click(),
    ]);

    expect(saveRequest).toBeTruthy();
    await expect(
      page.locator(".cds--actionable-notification, .cds--toast-notification"),
    ).toBeVisible({ timeout: UI_TIMEOUT });
  });

  test("Cancel button resets the form back to the search view", async ({
    page,
  }) => {
    await interceptSearch(page);
    await interceptStudyEdit(page);
    await page.goto("/PatientStudyEdit");

    await page.locator("#searchCriteria").selectOption("2");
    await page.locator("#patientSearchValue").fill("Dupont");
    await page.locator("#patientSearchButton").click();
    await expect(page.locator(".cds--data-table tbody tr")).toBeVisible({
      timeout: UI_TIMEOUT,
    });
    await page.locator(".cds--data-table tbody tr").first().click();
    await page.locator("#editPatientButton").click();

    await expect(page.locator("#studyTypeSelector")).toBeVisible({
      timeout: LONG_TIMEOUT,
    });
    await page.locator("#cancelPatientStudyButton").click();

    await expect(page.locator("#studyTypeSelector")).toBeHidden({
      timeout: SHORT_TIMEOUT,
    });
    await expect(page.locator("#searchCriteria")).toBeVisible({
      timeout: SHORT_TIMEOUT,
    });
  });
});

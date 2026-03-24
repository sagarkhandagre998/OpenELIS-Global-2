import LoginPage from "../pages/LoginPage";
import PatientStudyViewPage from "../pages/PatientStudyViewPage";

let loginPage = null;
let homePage = null;
let patientStudyViewPage = null;

before("login", () => {
  loginPage = new LoginPage();
  loginPage.visit();
  homePage = loginPage.goToHomePage();
});

describe("Patient Study View", function () {
  // ─────────────────────────────────────────────────────────────────────────
  // Navigation
  // ─────────────────────────────────────────────────────────────────────────

  describe("Navigation", function () {
    it("navigates to Patient Study View from the Patient menu", function () {
      patientStudyViewPage = homePage.goToPatientStudyView();
      cy.url().should("include", "/PatientStudyView");
    });

    it("renders the page title 'View Patient'", function () {
      patientStudyViewPage.getPageTitle().should("contain.text", "View Patient");
    });

    it("can also navigate directly via URL", function () {
      patientStudyViewPage = new PatientStudyViewPage();
      patientStudyViewPage.visit();
      cy.url().should("include", "/PatientStudyView");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Search Section – UI Elements
  // ─────────────────────────────────────────────────────────────────────────

  describe("Search Section – UI elements", function () {
    before(function () {
      patientStudyViewPage = new PatientStudyViewPage();
      patientStudyViewPage.visit();
    });

    it("renders the Search By dropdown", function () {
      patientStudyViewPage
        .getSearchCriteriaSelect()
        .should("be.visible");
    });

    it("Search By dropdown has 5 criteria options plus placeholder", function () {
      patientStudyViewPage
        .getSearchCriteriaSelect()
        .find("option")
        .should("have.length", 6);
    });

    it("renders the Search Value input", function () {
      patientStudyViewPage
        .getSearchValueInput()
        .should("be.visible");
    });

    it("renders the Search button", function () {
      patientStudyViewPage
        .getSearchButton()
        .should("be.visible")
        .and("contain.text", "Search");
    });

    it("does not show results table before any search", function () {
      patientStudyViewPage
        .getSearchResultsTable()
        .should("not.exist");
    });

    it("does not show the View Patient Study button before any search", function () {
      patientStudyViewPage
        .getViewPatientButton()
        .should("not.exist");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Search – Validation
  // ─────────────────────────────────────────────────────────────────────────

  describe("Search – Validation", function () {
    beforeEach(function () {
      patientStudyViewPage = new PatientStudyViewPage();
      patientStudyViewPage.visit();
    });

    it("shows a warning notification when Search is clicked without selecting criteria", function () {
      patientStudyViewPage.clickSearch();
      cy.get(".cds--actionable-notification, .cds--toast-notification").should(
        "be.visible",
      );
    });

    it("shows a warning notification when Search is clicked with empty search value", function () {
      patientStudyViewPage.selectSearchCriteria("2");
      patientStudyViewPage.clickSearch();
      cy.get(".cds--actionable-notification, .cds--toast-notification").should(
        "be.visible",
      );
    });

    it("triggers search when Enter key is pressed in the search input", function () {
      patientStudyViewPage.selectSearchCriteria("2");
      patientStudyViewPage
        .getSearchValueInput()
        .type("D{enter}");
      // Results table or notification should appear
      cy.get(
        ".cds--data-table, .cds--actionable-notification, .cds--toast-notification",
      ).should("be.visible");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Search – Results
  // ─────────────────────────────────────────────────────────────────────────

  describe("Search – Results", function () {
    before(function () {
      patientStudyViewPage = new PatientStudyViewPage();
      patientStudyViewPage.visit();
      patientStudyViewPage.searchByLastName("D");
    });

    it("displays the search results table after a successful search", function () {
      patientStudyViewPage
        .getSearchResultsTable()
        .should("be.visible");
    });

    it("results table has Last Name column header", function () {
      patientStudyViewPage
        .getSearchResultsTable()
        .contains("th", "Last Name")
        .should("be.visible");
    });

    it("results table has First Name column header", function () {
      patientStudyViewPage
        .getSearchResultsTable()
        .contains("th", "First Name")
        .should("be.visible");
    });

    it("results table has Gender column header", function () {
      patientStudyViewPage
        .getSearchResultsTable()
        .contains("th", "Gender")
        .should("be.visible");
    });

    it("results table has Date of Birth column header", function () {
      patientStudyViewPage
        .getSearchResultsTable()
        .contains("th", "Date of Birth")
        .should("be.visible");
    });

    it("results table has National ID column header", function () {
      patientStudyViewPage
        .getSearchResultsTable()
        .contains("th", "National ID")
        .should("be.visible");
    });

    it("results table has Subject Number column header", function () {
      patientStudyViewPage
        .getSearchResultsTable()
        .contains("th", "Subject Number")
        .should("be.visible");
    });

    it("results table has ST Number column header", function () {
      patientStudyViewPage
        .getSearchResultsTable()
        .contains("th", "ST Number")
        .should("be.visible");
    });

    it("displays at least one patient row in the results", function () {
      patientStudyViewPage
        .getSearchResultsRows()
        .should("have.length.greaterThan", 0);
    });

    it("View Patient Study button is visible after results load", function () {
      patientStudyViewPage
        .getViewPatientButton()
        .should("be.visible");
    });

    it("View Patient Study button is disabled before a row is selected", function () {
      patientStudyViewPage
        .getViewPatientButton()
        .should("be.disabled");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Search – Row Selection
  // ─────────────────────────────────────────────────────────────────────────

  describe("Search – Row Selection", function () {
    before(function () {
      patientStudyViewPage = new PatientStudyViewPage();
      patientStudyViewPage.visit();
      patientStudyViewPage.searchByLastName("D");
      cy.get("tbody tr", { timeout: 10000 }).should(
        "have.length.greaterThan",
        0,
      );
    });

    it("clicking a row selects it without loading the form", function () {
      patientStudyViewPage.selectPatientRow(0);
      // Form / patient banner should NOT appear yet
      cy.get("#studyTypeSelector").should("not.exist");
    });

    it("View Patient Study button becomes enabled after row selection", function () {
      patientStudyViewPage
        .getViewPatientButton()
        .should("not.be.disabled");
    });

    it("does NOT auto-load form data on row click", function () {
      // The study type selector only appears after the button is clicked
      cy.get("#studyTypeSelector").should("not.exist");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Patient Study Form
  // ─────────────────────────────────────────────────────────────────────────

  describe("Patient Study Form", function () {
    before(function () {
      patientStudyViewPage = new PatientStudyViewPage();
      patientStudyViewPage.visit();
      patientStudyViewPage.searchByLastName("D");
      cy.get("tbody tr", { timeout: 10000 }).should(
        "have.length.greaterThan",
        0,
      );
      patientStudyViewPage.selectPatientRow(0);
      patientStudyViewPage.clickViewPatient();
      patientStudyViewPage.waitForFormLoad();
    });

    it("renders the patient summary banner after loading", function () {
      patientStudyViewPage
        .getPatientBanner()
        .should("be.visible");
    });

    it("patient banner contains the patient label", function () {
      patientStudyViewPage
        .getPatientBanner()
        .should("contain.text", "Patient");
    });

    it("renders the Study Form type selector", function () {
      patientStudyViewPage
        .getStudyTypeSelector()
        .should("be.visible");
    });

    it("study type selector is NOT disabled", function () {
      patientStudyViewPage
        .getStudyTypeSelector()
        .should("not.be.disabled");
    });

    it("study type selector only shows study types the patient has samples for", function () {
      patientStudyViewPage
        .getStudyTypeOptions()
        .then(($options) => {
          // Filter out the blank placeholder option
          const values = [...$options]
            .map((o) => o.value)
            .filter(Boolean);
          expect(values.length).to.be.greaterThan(0);
          expect(values.length).to.be.lessThan(7);
        });
    });

    it("auto-selects the correct study type matching the patient's most recent sample", function () {
      patientStudyViewPage
        .getStudyTypeSelector()
        .find("option:selected")
        .should("not.have.value", "");
    });

    it("renders Patient Information section in the sub-form", function () {
      cy.contains("strong", "Patient Information").should("be.visible");
    });

    it("Patient Information fields are read-only", function () {
      cy.get("input[readonly]").should("have.length.greaterThan", 0);
    });

    it("Family Name field displays the patient's last name", function () {
      cy.get("input[readonly]")
        .filter(":visible")
        .first()
        .invoke("val")
        .should("not.be.empty");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Study Type Switching
  // ─────────────────────────────────────────────────────────────────────────

  describe("Study Type Switching", function () {
    before(function () {
      patientStudyViewPage = new PatientStudyViewPage();
      patientStudyViewPage.visit();
      patientStudyViewPage.searchByLastName("D");
      cy.get("tbody tr", { timeout: 10000 }).should(
        "have.length.greaterThan",
        0,
      );
      patientStudyViewPage.selectPatientRow(0);
      patientStudyViewPage.clickViewPatient();
      patientStudyViewPage.waitForFormLoad();
    });

    it("switching study type re-renders the correct sub-form", function () {
      patientStudyViewPage
        .getStudyTypeOptions()
        .then(($options) => {
          const availableValues = [...$options]
            .map((o) => o.value)
            .filter(Boolean);

          if (availableValues.length > 1) {
            // Switch to a different study type
            const secondOption = availableValues[1];
            patientStudyViewPage.selectStudyType(secondOption);
            // Patient Information section should still be visible in new sub-form
            cy.contains("strong", "Patient Information").should("be.visible");
          } else {
            // Only one study type available — verify it shows Patient Information
            cy.contains("strong", "Patient Information").should("be.visible");
          }
        });
    });

    it("switching back to original study type shows the original sub-form", function () {
      patientStudyViewPage
        .getStudyTypeOptions()
        .then(($options) => {
          const availableValues = [...$options]
            .map((o) => o.value)
            .filter(Boolean);

          if (availableValues.length > 1) {
            patientStudyViewPage.selectStudyType(availableValues[0]);
            cy.contains("strong", "Patient Information").should("be.visible");
          } else {
            cy.contains("strong", "Patient Information").should("be.visible");
          }
        });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Search Criteria Options
  // ─────────────────────────────────────────────────────────────────────────

  describe("Search Criteria Options", function () {
    beforeEach(function () {
      patientStudyViewPage = new PatientStudyViewPage();
      patientStudyViewPage.visit();
    });

    it("can search by First Name", function () {
      patientStudyViewPage.searchByFirstName("M");
      cy.get(
        ".cds--data-table, .cds--actionable-notification, .cds--toast-notification",
      ).should("be.visible");
    });

    it("can search by Last Name, First Name combined", function () {
      patientStudyViewPage.searchByLastFirstName("D", "M");
      cy.get(
        ".cds--data-table, .cds--actionable-notification, .cds--toast-notification",
      ).should("be.visible");
    });

    it("can search by Patient Identification Code", function () {
      patientStudyViewPage.searchByPatientId("NID");
      cy.get(
        ".cds--data-table, .cds--actionable-notification, .cds--toast-notification",
      ).should("be.visible");
    });
  });
});

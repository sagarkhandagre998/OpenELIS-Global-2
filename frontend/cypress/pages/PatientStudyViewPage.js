class PatientStudyViewPage {
  constructor() {
    this.selectors = {
      pageTitle: "h3, h2",
      searchCriteriaSelect: "#searchCriteria",
      searchValueInput: "#patientSearchValue",
      searchButton: "#patientSearchButton",
      searchResultsTable: ".cds--data-table",
      searchResultsRows: "tbody tr",
      viewPatientButton: "#viewPatientButton",
      studyTypeSelector: "#studyTypeSelector",
      patientBanner: "[data-testid='patient-banner']",
      loadingSpinner: ".cds--loading",
    };
  }

  visit() {
    cy.visit("/PatientStudyView");
  }

  getPageTitle() {
    return cy.get(this.selectors.pageTitle);
  }

  // ─── Search Section ───────────────────────────────────────────────────────

  getSearchCriteriaSelect() {
    return cy.get(this.selectors.searchCriteriaSelect);
  }

  getSearchValueInput() {
    return cy.get(this.selectors.searchValueInput);
  }

  getSearchButton() {
    return cy.get(this.selectors.searchButton);
  }

  selectSearchCriteria(value) {
    this.getSearchCriteriaSelect().select(value);
  }

  enterSearchValue(value) {
    this.getSearchValueInput().clear().type(value);
  }

  clickSearch() {
    this.getSearchButton().click();
  }

  searchByLastName(lastName) {
    this.selectSearchCriteria("2");
    this.enterSearchValue(lastName);
    this.clickSearch();
  }

  searchByFirstName(firstName) {
    this.selectSearchCriteria("1");
    this.enterSearchValue(firstName);
    this.clickSearch();
  }

  searchByLastFirstName(lastName, firstName) {
    this.selectSearchCriteria("3");
    this.enterSearchValue(`${lastName}, ${firstName}`);
    this.clickSearch();
  }

  searchByPatientId(patientId) {
    this.selectSearchCriteria("4");
    this.enterSearchValue(patientId);
    this.clickSearch();
  }

  searchByLabNo(labNo) {
    this.selectSearchCriteria("5");
    this.enterSearchValue(labNo);
    this.clickSearch();
  }

  // ─── Search Results ───────────────────────────────────────────────────────

  getSearchResultsTable() {
    return cy.get(this.selectors.searchResultsTable);
  }

  getSearchResultsRows() {
    return cy.get(this.selectors.searchResultsRows);
  }

  selectPatientRow(rowIndex = 0) {
    this.getSearchResultsRows().eq(rowIndex).click();
  }

  getViewPatientButton() {
    return cy.get(this.selectors.viewPatientButton);
  }

  clickViewPatient() {
    this.getViewPatientButton().click();
  }

  selectPatientAndView(rowIndex = 0) {
    this.selectPatientRow(rowIndex);
    this.clickViewPatient();
  }

  // ─── Patient Study Form ───────────────────────────────────────────────────

  getStudyTypeSelector() {
    return cy.get(this.selectors.studyTypeSelector);
  }

  selectStudyType(studyTypeId) {
    this.getStudyTypeSelector().select(studyTypeId);
  }

  getPatientBanner() {
    return cy.get(this.selectors.patientBanner);
  }

  getLoadingSpinner() {
    return cy.get(this.selectors.loadingSpinner);
  }

  waitForFormLoad() {
    cy.get(this.selectors.loadingSpinner, { timeout: 10000 }).should(
      "not.exist",
    );
  }

  getStudyTypeOptions() {
    return this.getStudyTypeSelector().find("option");
  }
}

export default PatientStudyViewPage;

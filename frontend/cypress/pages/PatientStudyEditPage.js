class PatientStudyEditPage {
  constructor() {
    this.selectors = {
      pageTitle: "h3, h2",
      searchCriteriaSelect: "#searchCriteria",
      searchValueInput: "#patientSearchValue",
      searchButton: "#patientSearchButton",
      searchResultsTable: ".cds--data-table",
      searchResultsRows: "tbody tr",
      editPatientButton: "#editPatientButton",
      studyTypeSelector: "#studyTypeSelector",
      patientBanner: "[data-testid='patient-edit-banner']",
      loadingSpinner: ".cds--loading",
      saveButton: "#savePatientStudyButton",
      cancelButton: "#cancelPatientStudyButton",
      lastNameInput: "#lastName",
      firstNameInput: "#firstName",
      genderSelect: "#gender",
      birthDateInput: "#birthDateForDisplay",
      subjectNumberInput: "#subjectNumber",
      siteSubjectNumberInput: "#siteSubjectNumber",
      labNoInput: "#labNo",
      receivedDateInput: "#receivedDateForDisplay",
      interviewDateInput: "#interviewDate",
    };
  }

  visit() {
    cy.visit("/PatientStudyEdit");
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

  getEditPatientButton() {
    return cy.get(this.selectors.editPatientButton);
  }

  clickEditPatient() {
    this.getEditPatientButton().click();
  }

  selectPatientAndEdit(rowIndex = 0) {
    this.selectPatientRow(rowIndex);
    this.clickEditPatient();
  }

  // ─── Patient Study Edit Form ──────────────────────────────────────────────

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

  // ─── Demographics Fields ──────────────────────────────────────────────────

  getLastNameInput() {
    return cy.get(this.selectors.lastNameInput);
  }

  getFirstNameInput() {
    return cy.get(this.selectors.firstNameInput);
  }

  getGenderSelect() {
    return cy.get(this.selectors.genderSelect);
  }

  getBirthDateInput() {
    return cy.get(this.selectors.birthDateInput);
  }

  getSubjectNumberInput() {
    return cy.get(this.selectors.subjectNumberInput);
  }

  getSiteSubjectNumberInput() {
    return cy.get(this.selectors.siteSubjectNumberInput);
  }

  getLabNoInput() {
    return cy.get(this.selectors.labNoInput);
  }

  getReceivedDateInput() {
    return cy.get(this.selectors.receivedDateInput);
  }

  getInterviewDateInput() {
    return cy.get(this.selectors.interviewDateInput);
  }

  fillLastName(value) {
    this.getLastNameInput().clear().type(value);
  }

  fillFirstName(value) {
    this.getFirstNameInput().clear().type(value);
  }

  selectGender(value) {
    this.getGenderSelect().select(value);
  }

  fillBirthDate(value) {
    this.getBirthDateInput().clear().type(value);
  }

  fillLabNo(value) {
    this.getLabNoInput().clear().type(value);
  }

  fillReceivedDate(value) {
    this.getReceivedDateInput().clear().type(value);
  }

  fillInterviewDate(value) {
    this.getInterviewDateInput().clear().type(value);
  }

  // ─── Action Buttons ───────────────────────────────────────────────────────

  getSaveButton() {
    return cy.get(this.selectors.saveButton);
  }

  getCancelButton() {
    return cy.get(this.selectors.cancelButton);
  }

  clickSave() {
    this.getSaveButton().click();
  }

  clickCancel() {
    this.getCancelButton().click();
  }

  // ─── Composite helpers ────────────────────────────────────────────────────

  /**
   * Searches by last name, selects the first result row, clicks Edit Patient Study,
   * waits for the form to load, selects the given study type, and returns this page.
   */
  loadPatientForEdit(lastName, studyTypeId) {
    this.searchByLastName(lastName);
    cy.get(this.selectors.searchResultsRows, { timeout: 8000 }).should(
      "have.length.at.least",
      1,
    );
    this.selectPatientAndEdit(0);
    this.waitForFormLoad();
    if (studyTypeId) {
      this.selectStudyType(studyTypeId);
    }
    return this;
  }
}

export default PatientStudyEditPage;

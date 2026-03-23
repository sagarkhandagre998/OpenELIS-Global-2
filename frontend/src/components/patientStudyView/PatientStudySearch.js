import React, { useContext, useState } from "react";
import {
  Button,
  Column,
  Select,
  SelectItem,
  TextInput,
  Loading,
  DataTable,
  Table,
  TableHead,
  TableRow,
  TableHeader,
  TableBody,
  TableCell,
  TableContainer,
  RadioButton,
  RadioButtonGroup,
} from "@carbon/react";
import { FormattedMessage, useIntl } from "react-intl";
import { getFromOpenElisServer } from "../utils/Utils";
import { NotificationContext } from "../layout/Layout";
import { NotificationKinds, AlertDialog } from "../common/CustomNotification";
import CustomDatePicker from "../common/CustomDatePicker";

const SCROLL_OFFSET = 50;

const SEARCH_CRITERIA_OPTIONS = [
  { id: "1", labelKey: "patient.epiFirstName", defaultMessage: "First Name" },
  { id: "2", labelKey: "patient.epiLastName", defaultMessage: "Last Name" },
  {
    id: "4",
    labelKey: "patient.search.nationalId",
    defaultMessage: "National ID / Subject No.",
  },
  { id: "5", labelKey: "patient.labNo", defaultMessage: "Lab Number" },
];

function noop() {}

const PatientStudySearch = ({
  setSelectedPatient = noop,
  setFormData = noop,
  setReferenceLists = noop,
  setLoading = noop,
  formRef,
}) => {
  const intl = useIntl();
  const { notificationVisible, setNotificationVisible, addNotification } =
    useContext(NotificationContext);

  const [searchCriteria, setSearchCriteria] = useState("2");
  const [searchValue, setSearchValue] = useState("");
  const [dob, setDob] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchCompleted, setSearchCompleted] = useState(false);
  const [selectedPatientId, setSelectedPatientId] = useState(null);

  const buildSearchParams = () => {
    const params = {};
    const trimmed = searchValue.trim();

    switch (searchCriteria) {
      case "1":
        params.firstName = trimmed;
        break;
      case "2":
        params.lastName = trimmed;
        break;
      case "4":
        params.nationalID = trimmed;
        params.subjectNumber = trimmed;
        break;
      case "5":
        params.labNumber = trimmed;
        break;
      default:
        params.lastName = trimmed;
    }

    if (dob) {
      params.dateOfBirth = dob;
    }

    return new URLSearchParams(params).toString();
  };

  const handleSearch = () => {
    const isCriteriaLabNo = searchCriteria === "5";
    const minLength = isCriteriaLabNo ? 3 : 1;

    if (!searchValue.trim() || searchValue.trim().length < minLength) {
      addNotification({
        kind: NotificationKinds.warning,
        title: intl.formatMessage({ id: "notification.title" }),
        message: intl.formatMessage({
          id: "patient.search.value.required",
          defaultMessage: "Please enter a search value",
        }),
      });
      setNotificationVisible(true);
      return;
    }

    setSearchLoading(true);
    setSearchCompleted(false);
    setSearchResults([]);
    setSelectedPatientId(null);

    getFromOpenElisServer(
      "/rest/patient-search-results?" + buildSearchParams(),
      handleSearchResponse,
    );
  };

  const handleSearchResponse = (response) => {
    setSearchLoading(false);
    setSearchCompleted(true);

    if (!response || !response.patientSearchResults) {
      setSearchResults([]);
      addNotification({
        kind: NotificationKinds.warning,
        title: intl.formatMessage({ id: "notification.title" }),
        message: intl.formatMessage({
          id: "patient.search.not.found",
          defaultMessage: "No patients found",
        }),
      });
      setNotificationVisible(true);
      return;
    }

    const results = response.patientSearchResults;
    setSearchResults(results);

    if (results.length === 0) {
      addNotification({
        kind: NotificationKinds.warning,
        title: intl.formatMessage({ id: "notification.title" }),
        message: intl.formatMessage({
          id: "patient.search.not.found",
          defaultMessage: "No patients found",
        }),
      });
      setNotificationVisible(true);
    }
  };

  const handlePatientSelect = (patientId) => {
    setSelectedPatientId(patientId);
  };

  const handleViewPatient = () => {
    if (!selectedPatientId) {
      addNotification({
        kind: NotificationKinds.warning,
        title: intl.formatMessage({ id: "notification.title" }),
        message: intl.formatMessage({
          id: "patient.select.required",
          defaultMessage: "Please select a patient",
        }),
      });
      setNotificationVisible(true);
      return;
    }

    setLoading(true);
    getFromOpenElisServer(
      "/rest/patient-study-view?patientID=" + selectedPatientId,
      (response) => {
        setLoading(false);
        if (!response) {
          addNotification({
            kind: NotificationKinds.error,
            title: intl.formatMessage({ id: "notification.title" }),
            message: intl.formatMessage({
              id: "error.system",
              defaultMessage: "Error loading patient data",
            }),
          });
          setNotificationVisible(true);
          return;
        }

        const patient = searchResults.find(
          (p) => String(p.patientID) === String(selectedPatientId),
        );
        setSelectedPatient(patient || null);
        setFormData(response.formData || {});
        setReferenceLists(response.referenceLists || {});

        // Scroll down to the form
        if (formRef?.current) {
          window.scrollTo({
            top: formRef.current.offsetTop - SCROLL_OFFSET,
            left: 0,
            behavior: "smooth",
          });
        }
      },
    );
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") {
      handleSearch();
    }
  };

  const searchResultHeaders = [
    {
      key: "select",
      header: "",
    },
    {
      key: "lastName",
      header: intl.formatMessage({
        id: "patient.epiLastName",
        defaultMessage: "Last Name",
      }),
    },
    {
      key: "firstName",
      header: intl.formatMessage({
        id: "patient.epiFirstName",
        defaultMessage: "First Name",
      }),
    },
    {
      key: "gender",
      header: intl.formatMessage({
        id: "patient.gender",
        defaultMessage: "Gender",
      }),
    },
    {
      key: "dob",
      header: intl.formatMessage({
        id: "patient.birthDate",
        defaultMessage: "Date of Birth",
      }),
    },
    {
      key: "nationalId",
      header: intl.formatMessage({
        id: "patient.NationalID",
        defaultMessage: "National ID",
      }),
    },
  ];

  const searchResultRows = searchResults.map((patient, index) => ({
    id: String(patient.patientID || index),
    select: patient.patientID,
    lastName: patient.lastName || "",
    firstName: patient.firstName || "",
    gender: patient.gender || "",
    dob: patient.dateOfBirth || "",
    nationalId: patient.nationalId || "",
  }));

  return (
    <>
      {notificationVisible === true ? <AlertDialog /> : ""}

      <Column lg={16} md={8} sm={4}>
        <hr />
      </Column>

      {/* Search criteria selector */}
      <Column lg={4} md={2} sm={4}>
        <Select
          id="searchCriteria"
          labelText={intl.formatMessage({
            id: "patient.search.criteria",
            defaultMessage: "Search By",
          })}
          value={searchCriteria}
          onChange={(e) => setSearchCriteria(e.target.value)}
        >
          {SEARCH_CRITERIA_OPTIONS.map((opt) => (
            <SelectItem
              key={opt.id}
              value={opt.id}
              text={intl.formatMessage({
                id: opt.labelKey,
                defaultMessage: opt.defaultMessage,
              })}
            />
          ))}
        </Select>
      </Column>

      {/* Search value input */}
      <Column lg={6} md={3} sm={4}>
        <TextInput
          id="patientSearchValue"
          labelText={intl.formatMessage({
            id: "eorder.searchValue",
            defaultMessage: "Search Value",
          })}
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={intl.formatMessage({
            id: "label.select.search.here",
            defaultMessage: "Enter search value...",
          })}
        />
      </Column>

      {/* Date of birth picker */}
      <Column lg={3} md={2} sm={4}>
        <CustomDatePicker
          id="patientSearchDob"
          labelText={intl.formatMessage({
            id: "patient.birthDate",
            defaultMessage: "Date of Birth",
          })}
          value={dob}
          onChange={(date) => setDob(date)}
        />
      </Column>

      {/* Search button */}
      <Column
        lg={3}
        md={1}
        sm={4}
        style={{ display: "flex", alignItems: "flex-end" }}
      >
        <Button
          id="patientSearchButton"
          onClick={handleSearch}
          disabled={searchLoading}
        >
          <FormattedMessage id="label.button.search" defaultMessage="Search" />
        </Button>
      </Column>

      {/* Loading spinner */}
      {searchLoading && (
        <Column lg={16} md={8} sm={4}>
          <Loading description="Searching patients..." small={true} />
        </Column>
      )}

      {/* Search results table */}
      {searchCompleted && searchResultRows.length > 0 && (
        <Column lg={16} md={8} sm={4} style={{ marginTop: "1rem" }}>
          <DataTable rows={searchResultRows} headers={searchResultHeaders}>
            {({ rows, headers, getHeaderProps, getTableProps }) => (
              <TableContainer
                title={intl.formatMessage({
                  id: "patient.search.results",
                  defaultMessage: "Search Results",
                })}
              >
                <Table {...getTableProps()} size="sm">
                  <TableHead>
                    <TableRow>
                      {headers.map((header) => (
                        <TableHeader
                          key={header.key}
                          {...getHeaderProps({ header })}
                        >
                          {header.header}
                        </TableHeader>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow
                        key={row.id}
                        onClick={() =>
                          handlePatientSelect(
                            row.cells.find((c) => c.info.header === "select")
                              ?.value,
                          )
                        }
                        style={{
                          cursor: "pointer",
                          backgroundColor:
                            String(selectedPatientId) === String(row.id)
                              ? "#e0f0ff"
                              : "transparent",
                        }}
                      >
                        {row.cells.map((cell) => {
                          if (cell.info.header === "select") {
                            return (
                              <TableCell key={cell.id}>
                                <RadioButtonGroup
                                  name="selectedPatient"
                                  valueSelected={String(selectedPatientId)}
                                  onChange={() =>
                                    handlePatientSelect(cell.value)
                                  }
                                >
                                  <RadioButton
                                    id={"sel_" + row.id}
                                    value={String(row.id)}
                                    labelText=""
                                  />
                                </RadioButtonGroup>
                              </TableCell>
                            );
                          }
                          return (
                            <TableCell key={cell.id}>{cell.value}</TableCell>
                          );
                        })}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </DataTable>

          {/* View selected patient button */}
          <div style={{ marginTop: "1rem" }}>
            <Button
              id="viewPatientButton"
              onClick={handleViewPatient}
              disabled={!selectedPatientId}
            >
              <FormattedMessage
                id="patient.study.view.load"
                defaultMessage="View Patient Study"
              />
            </Button>
          </div>
        </Column>
      )}

      {/* No results message */}
      {searchCompleted && searchResultRows.length === 0 && (
        <Column lg={16} md={8} sm={4} style={{ marginTop: "1rem" }}>
          <p>
            <FormattedMessage
              id="patient.search.not.found"
              defaultMessage="No patients found matching your search criteria."
            />
          </p>
        </Column>
      )}
    </>
  );
};

export default PatientStudySearch;

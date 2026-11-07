package protocol

import "fmt"

// Browser API messages (/api/connect). The client never sends or receives
// them; they are mirrored here so the shared fixtures prove both contracts
// use the same names and keys.

// PairingLookup describes the machine waiting for approval.
type PairingLookup struct {
	Name          string `json:"name"`
	Hostname      string `json:"hostname"`
	OS            OS     `json:"os"`
	Arch          Arch   `json:"arch"`
	ClientVersion string `json:"clientVersion"`
	ExpiresAt     string `json:"expiresAt"`
}

func (m *PairingLookup) UnmarshalJSON(data []byte) error {
	type plain PairingLookup
	return strictUnmarshal(data, (*plain)(m))
}

func (m *PairingLookup) Validate() error {
	return firstError(
		checkText("name", m.Name, MaxDeviceNameLength),
		checkText("hostname", m.Hostname, MaxHostnameLength),
		checkEnum("os", m.OS, OSValues),
		checkEnum("arch", m.Arch, ArchValues),
		checkPattern("clientVersion", m.ClientVersion, VersionRegexp),
		checkTimestamp("expiresAt", m.ExpiresAt),
	)
}

// PairingLookupResponse is the body of GET /api/connect/pairings/by-code/<userCode>.
type PairingLookupResponse struct {
	Pairing PairingLookup `json:"pairing"`
}

func (m *PairingLookupResponse) UnmarshalJSON(data []byte) error {
	type plain PairingLookupResponse
	return strictUnmarshal(data, (*plain)(m))
}

func (m *PairingLookupResponse) Validate() error {
	if err := m.Pairing.Validate(); err != nil {
		return fmt.Errorf("pairing.%w", err)
	}
	return nil
}

// PairingDecisionRequest is the body of POST /api/connect/pairings/by-code/<userCode>.
type PairingDecisionRequest struct {
	Decision PairingDecision `json:"decision"`
}

func (m *PairingDecisionRequest) UnmarshalJSON(data []byte) error {
	type plain PairingDecisionRequest
	return strictUnmarshal(data, (*plain)(m))
}

func (m *PairingDecisionRequest) Validate() error {
	return checkEnum("decision", m.Decision, PairingDecisions)
}

// PairingDecisionResponse is the answer to a pairing decision.
type PairingDecisionResponse struct {
	Status PairingStatus `json:"status"`
}

func (m *PairingDecisionResponse) UnmarshalJSON(data []byte) error {
	type plain PairingDecisionResponse
	return strictUnmarshal(data, (*plain)(m))
}

func (m *PairingDecisionResponse) Validate() error {
	return checkEnum("status", m.Status, []PairingStatus{PairingApproved, PairingDenied})
}

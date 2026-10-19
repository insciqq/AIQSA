package api

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

var (
	// ErrPairingDenied means the user denied this computer in AIQSA.
	ErrPairingDenied = errors.New("the request to connect this computer was denied in AIQSA")
	// ErrPairingExpired means the code expired before it was approved.
	ErrPairingExpired = errors.New("the code expired before it was approved; run aiqsa-connect login again")
)

// CreatePairing starts a pairing: POST /connect-api/v1/pairings → 201.
func (c *Client) CreatePairing(ctx context.Context, req protocol.PairingCreateRequest) (*protocol.PairingCreateResponse, error) {
	if err := req.Validate(); err != nil {
		return nil, err
	}
	var resp protocol.PairingCreateResponse
	if err := c.postJSON(ctx, protocol.PairingsPath, req, http.StatusCreated, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// PollPairing asks once whether the pairing was decided.
func (c *Client) PollPairing(ctx context.Context, req protocol.PairingPollRequest) (*protocol.PairingPollResponse, error) {
	var resp protocol.PairingPollResponse
	if err := c.postJSON(ctx, protocol.PairingPollPath, req, http.StatusOK, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// Approved is the device identity a pairing yields.
type Approved struct {
	DeviceID    string
	DeviceToken string
	// Account names the AIQSA account that approved the computer.
	Account string
}

// PairOptions customize WaitForApproval; zero values use real time.
type PairOptions struct {
	Now   func() time.Time
	Sleep func(ctx context.Context, d time.Duration) error
}

// Sleep waits for d or until ctx ends.
func Sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// WaitForApproval polls a pairing every intervalSeconds until it is
// approved, denied or expired. A 429 waits for its Retry-After; network
// failures are retried until the pairing expires.
func (c *Client) WaitForApproval(ctx context.Context, pairing *protocol.PairingCreateResponse, opts PairOptions) (Approved, error) {
	now, sleep := opts.Now, opts.Sleep
	if now == nil {
		now = time.Now
	}
	if sleep == nil {
		sleep = Sleep
	}
	expiresAt, err := time.Parse(time.RFC3339, pairing.ExpiresAt)
	if err != nil {
		return Approved{}, err
	}
	interval := time.Duration(pairing.IntervalSeconds) * time.Second
	wait := interval
	req := protocol.PairingPollRequest{PairingID: pairing.PairingID, PollSecret: pairing.PollSecret}
	for {
		if err := sleep(ctx, wait); err != nil {
			return Approved{}, err
		}
		if !now().Before(expiresAt) {
			return Approved{}, ErrPairingExpired
		}
		wait = interval
		resp, err := c.PollPairing(ctx, req)
		if err != nil {
			if ctx.Err() != nil {
				return Approved{}, ctx.Err()
			}
			apiErr, ok := AsError(err)
			switch {
			case !ok:
				continue
			case apiErr.Status == http.StatusTooManyRequests:
				wait = max(interval, apiErr.RetryAfter)
				continue
			case apiErr.Code == protocol.CodePairingExpired:
				return Approved{}, ErrPairingExpired
			case apiErr.Status >= 500:
				continue
			}
			return Approved{}, err
		}
		switch resp.Status {
		case protocol.PairingApproved:
			return Approved{DeviceID: *resp.DeviceID, DeviceToken: *resp.DeviceToken, Account: *resp.Account}, nil
		case protocol.PairingDenied:
			return Approved{}, ErrPairingDenied
		case protocol.PairingExpired:
			return Approved{}, ErrPairingExpired
		}
	}
}

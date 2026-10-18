// Package api talks to the AIQSA device API under /connect-api/v1: pairing,
// the device stream (SSE) and event batches. Requests carry the client
// version header, never an Origin header and never cookies.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// RequestTimeout bounds every request except the stream itself.
const RequestTimeout = 30 * time.Second

const maxErrorBodyBytes = 64 << 10

// Client is one AIQSA installation, optionally with a device token.
type Client struct {
	Origin  string
	Token   string
	Version string
	HTTP    *http.Client
}

// NewHTTPClient returns an HTTP client without a cookie jar and without
// redirects, so the bearer token only ever goes to the configured origin.
func NewHTTPClient() *http.Client {
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		IdleConnTimeout:       90 * time.Second,
		MaxIdleConnsPerHost:   4,
		ForceAttemptHTTP2:     true,
	}
	return &http.Client{
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// New returns a client for origin; token may be empty for pairing.
func New(origin, token, version string) *Client {
	return &Client{Origin: origin, Token: token, Version: version, HTTP: NewHTTPClient()}
}

// Error is a refused request: the HTTP status, the body's reason code (empty
// when the body was not `{code}`) and a Retry-After delay, if any.
type Error struct {
	Status     int
	Code       protocol.ReasonCode
	RetryAfter time.Duration
}

func (e *Error) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("AIQSA answered %d (%s)", e.Status, e.Code)
	}
	return fmt.Sprintf("AIQSA answered %d", e.Status)
}

// LogCode is the content-free form used by the log.
func (e *Error) LogCode() string {
	if e.Code != "" {
		return string(e.Code)
	}
	return "http_" + strconv.Itoa(e.Status)
}

// AsError returns the *Error inside err, if any.
func AsError(err error) (*Error, bool) {
	var apiErr *Error
	ok := errors.As(err, &apiErr)
	return apiErr, ok
}

// IsCode reports whether err is a refusal with code.
func IsCode(err error, code protocol.ReasonCode) bool {
	apiErr, ok := AsError(err)
	return ok && apiErr.Code == code
}

func (c *Client) newRequest(ctx context.Context, method, path string, body any) (*http.Request, error) {
	var reader io.Reader
	if body != nil {
		encoded, err := marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Origin+path, reader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set(protocol.ClientVersionHeader, c.Version)
	req.Header.Set("User-Agent", "aiqsa-connect/"+c.Version)
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	return req, nil
}

func (c *Client) do(req *http.Request) (*http.Response, error) {
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	return resp, nil
}

// responseError reads a refusal body and closes it.
func responseError(resp *http.Response) error {
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBodyBytes))
	apiErr := &Error{Status: resp.StatusCode, RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After"), time.Now())}
	var body protocol.ErrorResponse
	if protocol.Decode(data, &body) == nil {
		apiErr.Code = body.Code
	}
	return apiErr
}

func parseRetryAfter(value string, now time.Time) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	if seconds, err := strconv.Atoi(value); err == nil {
		if seconds < 0 {
			return 0
		}
		return time.Duration(min(seconds, 3600)) * time.Second
	}
	if at, err := http.ParseTime(value); err == nil {
		return min(max(at.Sub(now), 0), time.Hour)
	}
	return 0
}

// postJSON posts body and decodes a JSON response of status want into out.
func (c *Client) postJSON(ctx context.Context, path string, body any, want int, out protocol.Validator) error {
	ctx, cancel := context.WithTimeout(ctx, RequestTimeout)
	defer cancel()
	req, err := c.newRequest(ctx, http.MethodPost, path, body)
	if err != nil {
		return err
	}
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	if resp.StatusCode != want {
		return responseError(resp)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxErrorBodyBytes))
	if err != nil {
		return err
	}
	if err := protocol.Decode(data, out); err != nil {
		return fmt.Errorf("unexpected answer from AIQSA: %w", err)
	}
	return nil
}

// marshal encodes JSON without HTML escaping, so `<`, `>` and `&` in
// terminal text keep their one-byte size.
func marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// Marshal is the JSON encoding the client uses on the wire.
func Marshal(v any) ([]byte, error) { return marshal(v) }

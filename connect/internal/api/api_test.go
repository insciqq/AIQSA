package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

func TestSSEReaderParsesFields(t *testing.T) {
	input := ": comment\n\n" +
		"event: hello\ndata: {\"a\":1}\n\n" +
		"event:command\ndata:line1\r\ndata: line2\r\n\r\n" +
		"data: plain\nid: 7\nretry: 100\n\n" +
		"event: ignored-without-data\n\n" +
		"event: ping\ndata: {}\n\n" +
		"event: partial\ndata: x"
	reader := NewSSEReader(strings.NewReader(input))
	want := []Event{
		{Name: "hello", Data: []byte(`{"a":1}`)},
		{Name: "command", Data: []byte("line1\nline2")},
		{Name: "message", Data: []byte("plain")},
		{Name: "ping", Data: []byte("{}")},
	}
	for _, w := range want {
		got, err := reader.Next()
		if err != nil || got.Name != w.Name || string(got.Data) != string(w.Data) {
			t.Fatalf("got %q %q %v, want %q %q", got.Name, got.Data, err, w.Name, w.Data)
		}
	}
	if _, err := reader.Next(); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("unterminated event: %v", err)
	}
}

func TestSSEReaderBoundsEventSize(t *testing.T) {
	reader := NewSSEReader(strings.NewReader("data: " + strings.Repeat("x", 200) + "\n\n"))
	reader.max = 100
	if _, err := reader.Next(); !errors.Is(err, ErrEventTooLarge) {
		t.Fatalf("got %v", err)
	}
}

func TestRequestsCarryVersionHeaderWithoutOriginOrCookies(t *testing.T) {
	var seen atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen.Add(1)
		if r.Header.Get(protocol.ClientVersionHeader) != "1.2.3" || r.Header.Get("Origin") != "" || r.Header.Get("Cookie") != "" {
			t.Errorf("headers: %v", r.Header)
		}
		if r.URL.Path == protocol.DeviceEventsPath {
			if r.Header.Get("Authorization") != "Bearer tok" {
				t.Errorf("authorization: %q", r.Header.Get("Authorization"))
			}
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "x"})
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		io.WriteString(w, `{"code":"connect_stream_required"}`)
	}))
	defer srv.Close()
	client := New(srv.URL, "tok", "1.2.3")
	if err := client.PostEvents(context.Background(), []byte(`{"events":[]}`)); err != nil {
		t.Fatal(err)
	}
	if err := client.PostEvents(context.Background(), []byte(`{"events":[]}`)); err != nil {
		t.Fatal(err)
	}
	client.Origin = srv.URL + "/conflict"
	err := client.PostEvents(context.Background(), []byte(`{}`))
	if !IsCode(err, protocol.CodeStreamRequired) {
		t.Fatalf("got %v", err)
	}
	if seen.Load() != 3 {
		t.Fatalf("requests: %d", seen.Load())
	}
}

func TestPlainHTTPGoesOnlyDirectlyToLocalAddresses(t *testing.T) {
	// 192.0.2.1 (TEST-NET-1) is outside the local network: refused before a
	// packet is sent.
	err := New("http://192.0.2.1:9", "tok", "1.2.3").PostEvents(context.Background(), []byte(`{}`))
	if err != ErrPlainHTTPNotLocal {
		t.Fatalf("public address: %v", err)
	}
	for address, local := range map[string]bool{
		"127.0.0.1:80": true, "[::1]:80": true, "10.0.0.1:80": true, "172.31.255.1:80": true,
		"192.168.1.10:3000": true, "100.101.102.103:80": true, "169.254.1.1:80": true,
		"[fd12::1]:80": true, "[fe80::1%eth0]:80": true, "[::ffff:192.168.1.10]:80": true,
		"192.0.2.1:80": false, "8.8.8.8:53": false, "172.32.0.1:80": false, "100.128.0.1:80": false,
		"0.0.0.0:80": false, "[2001:4860::8888]:80": false, "[ff02::1]:80": false,
	} {
		if got := refuseNonLocal("tcp", address, nil) == nil; got != local {
			t.Errorf("%s: allowed %v, want %v", address, got, local)
		}
	}
	if transport := NewHTTPClient().Transport.(schemeTransport); transport.plain.Proxy != nil || transport.secure.Proxy == nil {
		t.Fatal("plain http must not use a proxy; https keeps the environment's")
	}
}

func TestRetryAfter(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	if parseRetryAfter("5", now) != 5*time.Second || parseRetryAfter("", now) != 0 || parseRetryAfter("x", now) != 0 {
		t.Fatal("seconds")
	}
	if got := parseRetryAfter(now.Add(7*time.Second).Format(http.TimeFormat), now); got != 7*time.Second {
		t.Fatalf("date: %v", got)
	}
}

const (
	testPairingID = "11111111-2222-4333-8444-555555555555"
	testDeviceID  = "0b5e8c1e-7f43-4c55-9a43-7d1f5c0e2a11"
)

var testPollSecret = strings.Repeat("s", 43)
var testToken = "aiqsa_connect_" + strings.Repeat("T", 43)

func TestPairingPollsUntilApproved(t *testing.T) {
	var polls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case protocol.PairingsPath:
			var req protocol.PairingCreateRequest
			if err := protocol.Decode(data, &req); err != nil {
				t.Errorf("create body: %v", err)
			}
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(protocol.PairingCreateResponse{
				PairingID: testPairingID, UserCode: "ABCD-EFGH", VerificationURI: "https://ai.example.com/connect/pair?code=ABCD-EFGH",
				PollSecret: testPollSecret, ExpiresAt: protocol.FormatTimestamp(time.Now().Add(time.Minute)), IntervalSeconds: 2,
			})
		case protocol.PairingPollPath:
			var req protocol.PairingPollRequest
			if err := protocol.Decode(data, &req); err != nil || req.PollSecret != testPollSecret {
				t.Errorf("poll body: %v", err)
			}
			switch polls.Add(1) {
			case 1:
				io.WriteString(w, `{"status":"pending"}`)
			case 2:
				w.Header().Set("Retry-After", "9")
				w.WriteHeader(http.StatusTooManyRequests)
				io.WriteString(w, `{"code":"connect_rate_limited"}`)
			default:
				json.NewEncoder(w).Encode(map[string]string{"status": "approved", "deviceId": testDeviceID, "deviceToken": testToken, "account": "Owner (o•••@example.test)"})
			}
		}
	}))
	defer srv.Close()
	client := New(srv.URL, "", "dev")
	pairing, err := client.CreatePairing(context.Background(), protocol.PairingCreateRequest{
		Name: "laptop", Hostname: "laptop", OS: protocol.OSLinux, Arch: protocol.ArchAMD64, ClientVersion: "dev",
	})
	if err != nil {
		t.Fatal(err)
	}
	var waits []time.Duration
	approved, err := client.WaitForApproval(context.Background(), pairing, PairOptions{Sleep: func(_ context.Context, d time.Duration) error {
		waits = append(waits, d)
		return nil
	}})
	if err != nil || approved.DeviceID != testDeviceID || approved.DeviceToken != testToken || approved.Account != "Owner (o•••@example.test)" {
		t.Fatalf("approved: %+v %v", approved, err)
	}
	if len(waits) != 3 || waits[0] != 2*time.Second || waits[1] != 2*time.Second || waits[2] != 9*time.Second {
		t.Fatalf("waits: %v", waits)
	}
}

func TestPairingDeniedAndExpired(t *testing.T) {
	status := "denied"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"status":"`+status+`"}`)
	}))
	defer srv.Close()
	client := New(srv.URL, "", "dev")
	pairing := &protocol.PairingCreateResponse{PairingID: testPairingID, PollSecret: testPollSecret, IntervalSeconds: 2,
		ExpiresAt: protocol.FormatTimestamp(time.Now().Add(time.Minute))}
	noSleep := PairOptions{Sleep: func(context.Context, time.Duration) error { return nil }}
	if _, err := client.WaitForApproval(context.Background(), pairing, noSleep); !errors.Is(err, ErrPairingDenied) {
		t.Fatalf("denied: %v", err)
	}
	status = "expired"
	if _, err := client.WaitForApproval(context.Background(), pairing, noSleep); !errors.Is(err, ErrPairingExpired) {
		t.Fatalf("expired: %v", err)
	}
	status = "pending"
	late := noSleep
	late.Now = func() time.Time { return time.Now().Add(2 * time.Minute) }
	if _, err := client.WaitForApproval(context.Background(), pairing, late); !errors.Is(err, ErrPairingExpired) {
		t.Fatalf("deadline: %v", err)
	}
}

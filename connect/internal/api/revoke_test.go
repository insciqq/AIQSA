package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

func TestRevokeSelfDeletesTheDeviceWithItsToken(t *testing.T) {
	cases := map[string]struct {
		status int
		body   string
		ok     bool
		code   protocol.ReasonCode
	}{
		"deleted":         {http.StatusNoContent, "", true, ""},
		"deleted with ok": {http.StatusOK, `{"ok":true}`, true, ""},
		"already revoked": {http.StatusUnauthorized, `{"code":"connect_unauthorized"}`, true, ""},
		"turned off":      {http.StatusForbidden, `{"code":"connect_disabled"}`, false, protocol.CodeDisabled},
		"server failure":  {http.StatusInternalServerError, "", false, ""},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			calls := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.Method != http.MethodDelete || r.URL.Path != DeviceSelfPath {
					t.Errorf("request %s %s", r.Method, r.URL.Path)
				}
				if r.Header.Get("Authorization") != "Bearer tok" || r.Header.Get("Origin") != "" || r.Header.Get("Cookie") != "" ||
					r.Header.Get(protocol.ClientVersionHeader) != "1.2.3" {
					t.Errorf("headers: %v", r.Header)
				}
				if data, _ := io.ReadAll(r.Body); len(data) != 0 {
					t.Errorf("body sent: %q", data)
				}
				w.WriteHeader(tc.status)
				io.WriteString(w, tc.body)
			}))
			defer srv.Close()
			err := New(srv.URL, "tok", "1.2.3").RevokeSelf(context.Background())
			if (err == nil) != tc.ok {
				t.Fatalf("err = %v", err)
			}
			if tc.code != "" && !IsCode(err, tc.code) {
				t.Fatalf("err = %v, want %s", err, tc.code)
			}
			if calls != 1 {
				t.Fatalf("calls = %d", calls)
			}
		})
	}
}

func TestRevokeSelfNeedsATokenAndReportsAnUnreachableServer(t *testing.T) {
	if err := New("https://ai.example.com", "", "1.2.3").RevokeSelf(context.Background()); !errors.Is(err, ErrNoDeviceToken) {
		t.Fatalf("err = %v", err)
	}
	srv := httptest.NewServer(http.NotFoundHandler())
	origin := srv.URL
	srv.Close()
	err := New(origin, "tok", "1.2.3").RevokeSelf(context.Background())
	if err == nil {
		t.Fatal("an unreachable server counted as revoked")
	}
	if _, ok := AsError(err); ok {
		t.Fatalf("err = %v, want a network error", err)
	}
}

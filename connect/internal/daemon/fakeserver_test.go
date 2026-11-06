package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/logx"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/state"
)

const (
	testDeviceID = "0b5e8c1e-7f43-4c55-9a43-7d1f5c0e2a11"
	testVersion  = "1.2.3"
)

var testToken = "aiqsa_connect_" + strings.Repeat("T", 43)

// fakeServer is the device API of an AIQSA installation speaking protocol
// 2, in memory. Every batch the client posts is decoded strictly and validated.
type fakeServer struct {
	t   *testing.T
	srv *httptest.Server

	streams chan *fakeStream
	events  chan protocol.DeviceEvent

	mu            sync.Mutex
	streamRefusal *refusal
	eventsReplies []refusal // consumed one per POST before succeeding
	eventsDelay   time.Duration
	limits        protocol.HelloV2Limits
	batchSizes    []int
	batchBytes    []int
	recorded      []protocol.DeviceEvent

	requests    atomic.Int32
	inFlight    atomic.Int32
	maxInFlight atomic.Int32
	streamOpens atomic.Int32
}

type refusal struct {
	status int
	code   protocol.ReasonCode
}

type fakeStream struct {
	frames chan string
	end    chan struct{}
	once   sync.Once
}

func (s *fakeStream) send(event string, data any) {
	encoded, err := json.Marshal(data)
	if err != nil {
		panic(err)
	}
	s.frames <- fmt.Sprintf("event: %s\ndata: %s\n\n", event, encoded)
}

func (s *fakeStream) command(data any) { s.send(protocol.StreamEventCommand, data) }

func (s *fakeStream) drop() { s.once.Do(func() { close(s.end) }) }

func newFakeServer(t *testing.T) *fakeServer {
	f := &fakeServer{
		t:       t,
		streams: make(chan *fakeStream, 16),
		events:  make(chan protocol.DeviceEvent, 4096),
		limits:  protocol.DefaultHelloV2Limits,
	}
	f.srv = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeServer) checkHeaders(r *http.Request) {
	f.requests.Add(1)
	if r.Header.Get("Authorization") != "Bearer "+testToken {
		f.t.Errorf("authorization header: %q", r.Header.Get("Authorization"))
	}
	if r.Header.Get(protocol.ClientVersionHeader) != testVersion {
		f.t.Errorf("version header: %q", r.Header.Get(protocol.ClientVersionHeader))
	}
	if r.Header.Get(protocol.ProtocolHeader) != strconv.Itoa(protocol.ProtocolVersion) {
		f.t.Errorf("protocol header: %q", r.Header.Get(protocol.ProtocolHeader))
	}
	if r.Header.Get("Origin") != "" || r.Header.Get("Cookie") != "" {
		f.t.Errorf("origin or cookie sent: %v", r.Header)
	}
}

func writeCode(w http.ResponseWriter, status int, code protocol.ReasonCode) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	fmt.Fprintf(w, `{"code":%q}`, code)
}

func (f *fakeServer) handle(w http.ResponseWriter, r *http.Request) {
	f.checkHeaders(r)
	switch r.URL.Path {
	case protocol.DeviceStreamPath:
		f.handleStream(w, r)
	case protocol.DeviceEventsPath:
		f.handleEvents(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (f *fakeServer) hello() protocol.HelloV2 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return protocol.HelloV2{Protocol: 2, DeviceID: testDeviceID, ServerVersion: "1.2.4", MinClientVersion: "1.0.0", Limits: f.limits}
}

func (f *fakeServer) handleStream(w http.ResponseWriter, r *http.Request) {
	f.streamOpens.Add(1)
	f.mu.Lock()
	refused := f.streamRefusal
	f.mu.Unlock()
	if refused != nil {
		writeCode(w, refused.status, refused.code)
		return
	}
	if r.Header.Get("Accept") != "text/event-stream" {
		f.t.Errorf("accept header: %q", r.Header.Get("Accept"))
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	flusher := w.(http.Flusher)
	stream := &fakeStream{frames: make(chan string, 256), end: make(chan struct{})}
	io.WriteString(w, ": connected\n\n")
	stream.send(protocol.StreamEventHello, f.hello())
	f.streams <- stream
	for {
		select {
		case frame := <-stream.frames:
			io.WriteString(w, frame)
			flusher.Flush()
		case <-stream.end:
			return
		case <-r.Context().Done():
			return
		}
	}
}

func (f *fakeServer) handleEvents(w http.ResponseWriter, r *http.Request) {
	n := f.inFlight.Add(1)
	defer f.inFlight.Add(-1)
	for {
		seen := f.maxInFlight.Load()
		if n <= seen || f.maxInFlight.CompareAndSwap(seen, n) {
			break
		}
	}
	body, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	delay := f.eventsDelay
	limits := f.limits
	var reply *refusal
	if len(f.eventsReplies) > 0 {
		reply = &f.eventsReplies[0]
		f.eventsReplies = f.eventsReplies[1:]
	}
	f.mu.Unlock()
	time.Sleep(delay)
	if reply != nil {
		writeCode(w, reply.status, reply.code)
		return
	}
	var batch protocol.EventBatchV2
	if err := protocol.Decode(body, &batch); err != nil {
		f.t.Errorf("invalid batch: %v (%d bytes)", err, len(body))
		writeCode(w, http.StatusBadRequest, protocol.CodeRequestInvalid)
		return
	}
	if len(batch.Events) > limits.MaxEventsPerPost || len(body) > limits.MaxEventsBodyBytes {
		f.t.Errorf("batch over limits: %d events, %d bytes", len(batch.Events), len(body))
	}
	for _, event := range batch.Events {
		if reply, ok := event.(*protocol.OpReplyEvent); ok {
			encoded, _ := json.Marshal(reply)
			if len(encoded) > limits.MaxReplyBytes {
				f.t.Errorf("reply of %d bytes over %d", len(encoded), limits.MaxReplyBytes)
			}
		}
	}
	f.mu.Lock()
	f.batchSizes = append(f.batchSizes, len(batch.Events))
	f.batchBytes = append(f.batchBytes, len(body))
	f.recorded = append(f.recorded, batch.Events...)
	f.mu.Unlock()
	for _, event := range batch.Events {
		f.events <- event
	}
	w.WriteHeader(http.StatusNoContent)
}

func (f *fakeServer) nextStream(t *testing.T) *fakeStream {
	t.Helper()
	select {
	case s := <-f.streams:
		return s
	case <-time.After(10 * time.Second):
		t.Fatal("no stream opened")
		return nil
	}
}

// waitEvent returns the first posted event matching match.
func (f *fakeServer) waitEvent(t *testing.T, match func(protocol.DeviceEvent) bool) protocol.DeviceEvent {
	t.Helper()
	deadline := time.After(15 * time.Second)
	for {
		select {
		case event := <-f.events:
			if match(event) {
				return event
			}
		case <-deadline:
			t.Fatal("event not posted")
			return nil
		}
	}
}

func isType(eventType string) func(protocol.DeviceEvent) bool {
	return func(e protocol.DeviceEvent) bool { return e.EventType() == eventType }
}

func replyFor(requestID string) func(protocol.DeviceEvent) bool {
	return func(e protocol.DeviceEvent) bool {
		reply, ok := e.(*protocol.OpReplyEvent)
		return ok && reply.RequestID == requestID
	}
}

type recordingUpdater struct {
	mu    sync.Mutex
	calls [][2]string
}

func (u *recordingUpdater) OnServerVersion(server, minClient string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.calls = append(u.calls, [2]string{server, minClient})
}

func (u *recordingUpdater) count() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return len(u.calls)
}

// syncBuffer is a goroutine-safe log sink.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// stateRecorder keeps every reported state.
type stateRecorder struct {
	mu     sync.Mutex
	states []state.State
}

func (r *stateRecorder) sink(s state.State) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.states = append(r.states, s)
}

func (r *stateRecorder) kinds() []state.Kind {
	r.mu.Lock()
	defer r.mu.Unlock()
	kinds := make([]state.Kind, len(r.states))
	for i, s := range r.states {
		kinds[i] = s.Kind
	}
	return kinds
}

type harness struct {
	server   *fakeServer
	daemon   *Daemon
	log      *syncBuffer
	notices  *syncBuffer
	updater  *recordingUpdater
	states   *stateRecorder
	home     string
	stateDir string
	cancel   context.CancelFunc
	done     chan error
}

func fastTiming() Timing {
	return Timing{
		IdleTimeout:   10 * time.Second,
		BackoffMin:    10 * time.Millisecond,
		BackoffMax:    50 * time.Millisecond,
		DisabledRetry: 50 * time.Millisecond,
		RetryMin:      10 * time.Millisecond,
		RetryMax:      50 * time.Millisecond,
	}
}

func newHarness(t *testing.T, server *fakeServer, timing Timing) *harness {
	t.Helper()
	h := &harness{
		server: server, log: &syncBuffer{}, notices: &syncBuffer{}, updater: &recordingUpdater{},
		states: &stateRecorder{}, home: t.TempDir(), stateDir: t.TempDir(),
	}
	d, err := New(Options{
		Credentials: config.Credentials{Origin: server.srv.URL, DeviceID: testDeviceID, DeviceToken: testToken},
		Paths:       config.Paths{StateDir: h.stateDir, ConfigDir: t.TempDir()},
		Version:     testVersion,
		Log:         logx.New(h.log),
		Updater:     h.updater,
		Notices:     h.notices,
		Home:        h.home,
		Timing:      timing,
		OnState:     h.states.sink,
	})
	if err != nil {
		t.Fatal(err)
	}
	h.daemon = d
	return h
}

func (h *harness) start() {
	ctx, cancel := context.WithCancel(context.Background())
	h.cancel = cancel
	h.done = make(chan error, 1)
	go func() { h.done <- h.daemon.Run(ctx) }()
}

func (h *harness) wait(t *testing.T) error {
	t.Helper()
	select {
	case err := <-h.done:
		return err
	case <-time.After(15 * time.Second):
		t.Fatal("daemon did not stop")
		return nil
	}
}

func (h *harness) stop(t *testing.T) {
	t.Helper()
	h.cancel()
	if err := h.wait(t); err != nil {
		t.Fatalf("run: %v", err)
	}
}

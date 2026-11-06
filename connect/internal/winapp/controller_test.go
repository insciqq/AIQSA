package winapp

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/api"
	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/state"
)

type fakeUI struct {
	mu       sync.Mutex
	states   []state.State
	notices  []string
	opened   []string
	confirms []bool
	exited   chan struct{}
	changed  chan struct{}
}

func newFakeUI() *fakeUI {
	return &fakeUI{exited: make(chan struct{}), changed: make(chan struct{}, 1000)}
}

func (u *fakeUI) Show(s state.State) {
	u.mu.Lock()
	u.states = append(u.states, s)
	u.mu.Unlock()
	u.changed <- struct{}{}
}

func (u *fakeUI) Notify(text string) {
	u.mu.Lock()
	u.notices = append(u.notices, text)
	u.mu.Unlock()
	u.changed <- struct{}{}
}

func (u *fakeUI) Confirm(string, string) bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	if len(u.confirms) == 0 {
		return false
	}
	answer := u.confirms[0]
	u.confirms = u.confirms[1:]
	return answer
}

func (u *fakeUI) OpenURL(url string) error {
	u.mu.Lock()
	u.opened = append(u.opened, url)
	u.mu.Unlock()
	return nil
}

func (u *fakeUI) Exit() { close(u.exited) }

func (u *fakeUI) last() state.State {
	u.mu.Lock()
	defer u.mu.Unlock()
	if len(u.states) == 0 {
		return state.State{}
	}
	return u.states[len(u.states)-1]
}

func (u *fakeUI) noticeText() string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return strings.Join(u.notices, "\n")
}

// waitFor waits until the last state has kind.
func (u *fakeUI) waitFor(t *testing.T, kind state.Kind) state.State {
	t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		if last := u.last(); last.Kind == kind {
			return last
		}
		select {
		case <-u.changed:
		case <-timeout:
			t.Fatalf("state %s never came; last %+v", kind, u.last())
		}
	}
}

type fakeDeviceAPI struct {
	mu          sync.Mutex
	origin      string
	token       string
	createErr   error
	verifyURI   string
	approval    chan error
	revokeErr   error
	revokes     []string
	created     []protocol.PairingCreateRequest
	approvedFor string
}

func (a *fakeDeviceAPI) CreatePairing(_ context.Context, req protocol.PairingCreateRequest) (*protocol.PairingCreateResponse, error) {
	a.mu.Lock()
	a.created = append(a.created, req)
	a.mu.Unlock()
	if a.createErr != nil {
		return nil, a.createErr
	}
	uri := a.verifyURI
	if uri == "" {
		uri = a.origin + "/connect/pair?code=ABCD-EFGH"
	}
	return &protocol.PairingCreateResponse{UserCode: "ABCD-EFGH", VerificationURI: uri}, nil
}

func (a *fakeDeviceAPI) WaitForApproval(ctx context.Context, _ *protocol.PairingCreateResponse, _ api.PairOptions) (api.Approved, error) {
	select {
	case <-ctx.Done():
		return api.Approved{}, ctx.Err()
	case err := <-a.approval:
		if err != nil {
			return api.Approved{}, err
		}
		return api.Approved{DeviceID: testDeviceID, DeviceToken: testToken, Account: "owner@example.test"}, nil
	}
}

func (a *fakeDeviceAPI) RevokeSelf(context.Context) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.revokes = append(a.revokes, a.token)
	return a.revokeErr
}

type fakeDaemon struct {
	mu     sync.Mutex
	runs   int
	result chan error
}

func (d *fakeDaemon) run(ctx context.Context, creds config.Credentials, sink state.Sink) error {
	d.mu.Lock()
	d.runs++
	d.mu.Unlock()
	sink.Report(state.State{Kind: state.Connected, Origin: creds.Origin})
	select {
	case <-ctx.Done():
		sink.Report(state.State{Kind: state.Stopped, Origin: creds.Origin})
		return nil
	case err := <-d.result:
		return err
	}
}

func (d *fakeDaemon) count() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.runs
}

type controllerFixture struct {
	controller *Controller
	ui         *fakeUI
	api        *fakeDeviceAPI
	daemon     *fakeDaemon
	paths      config.Paths
}

func newControllerFixture(t *testing.T) *controllerFixture {
	t.Helper()
	dir := t.TempDir()
	f := &controllerFixture{
		ui:     newFakeUI(),
		api:    &fakeDeviceAPI{origin: testOrigin, approval: make(chan error, 1)},
		daemon: &fakeDaemon{result: make(chan error, 1)},
		paths:  config.Paths{ConfigDir: filepath.Join(dir, "config"), StateDir: filepath.Join(dir, "state")},
	}
	f.controller = &Controller{
		Origin:  testOrigin,
		Version: "1.2.3",
		Device:  Device{Name: "DESKTOP-7Q2", Hostname: "DESKTOP-7Q2", OS: protocol.OSWindows, Arch: protocol.ArchAMD64},
		Paths:   f.paths,
		API: func(origin, token string) DeviceAPI {
			f.api.mu.Lock()
			defer f.api.mu.Unlock()
			if origin != testOrigin {
				t.Errorf("API for %s", origin)
			}
			f.api.token = token
			return f.api
		},
		Daemon: f.daemon.run,
		UI:     f.ui,
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		cancel()
		f.controller.stopSession()
	})
	f.controller.Start(ctx)
	return f
}

func (f *controllerFixture) saveCredentials(t *testing.T) {
	t.Helper()
	if err := f.paths.SaveCredentials(config.Credentials{Origin: testOrigin, DeviceID: testDeviceID, DeviceToken: testToken}); err != nil {
		t.Fatal(err)
	}
}

// choose runs a menu command and waits for it to finish.
func (f *controllerFixture) choose(id MenuID) { f.controller.Do(id) }

func TestTrayPairsThroughTheBrowserThenConnects(t *testing.T) {
	f := newControllerFixture(t)
	pairing := f.ui.waitFor(t, state.Pairing)
	if pairing.UserCode != "ABCD-EFGH" || pairing.VerificationURI != testOrigin+"/connect/pair?code=ABCD-EFGH" {
		t.Fatalf("pairing state %+v", pairing)
	}
	if view := ViewOf(pairing); view.Status != "Waiting for approval · ABCD-EFGH" || view.Icon != IconWaiting {
		t.Fatalf("view %+v", view)
	}
	if len(f.ui.opened) != 1 || f.ui.opened[0] != pairing.VerificationURI {
		t.Fatalf("opened %v", f.ui.opened)
	}
	if got := f.api.created[0]; got.Name != "DESKTOP-7Q2" || got.OS != protocol.OSWindows || got.ClientVersion != "1.2.3" {
		t.Fatalf("pairing request %+v", got)
	}
	// Open AIQSA while waiting opens the approval page again.
	f.choose(MenuOpen)
	if len(f.ui.opened) != 2 || f.ui.opened[1] != pairing.VerificationURI {
		t.Fatalf("opened %v", f.ui.opened)
	}

	f.api.approval <- nil
	connected := f.ui.waitFor(t, state.Connected)
	if view := ViewOf(connected); view.Status != "Connected to ai.example.com" || view.Icon != IconConnected {
		t.Fatalf("view %+v", view)
	}
	creds, err := f.paths.LoadCredentials()
	if err != nil || creds.DeviceToken != testToken || creds.Origin != testOrigin {
		t.Fatalf("credentials %+v %v", creds, err)
	}
	if !strings.Contains(f.ui.noticeText(), "Connected to ai.example.com for owner@example.test.") {
		t.Fatalf("notices %q", f.ui.noticeText())
	}
	if strings.Contains(f.ui.noticeText(), testToken) {
		t.Fatal("token shown")
	}
	f.choose(MenuOpen)
	if f.ui.opened[len(f.ui.opened)-1] != testOrigin {
		t.Fatalf("opened %v", f.ui.opened)
	}
}

func TestTrayWithCredentialsStartsTheDaemonAtOnce(t *testing.T) {
	dir := t.TempDir()
	paths := config.Paths{ConfigDir: filepath.Join(dir, "config"), StateDir: filepath.Join(dir, "state")}
	if err := paths.SaveCredentials(config.Credentials{Origin: testOrigin, DeviceID: testDeviceID, DeviceToken: testToken}); err != nil {
		t.Fatal(err)
	}
	ui := newFakeUI()
	daemon := &fakeDaemon{result: make(chan error, 1)}
	c := &Controller{Origin: testOrigin, Paths: paths, Daemon: daemon.run, UI: ui,
		API: func(string, string) DeviceAPI { t.Error("pairing with credentials"); return &fakeDeviceAPI{} }}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.Start(ctx)
	ui.waitFor(t, state.Connected)
	if len(ui.opened) != 0 {
		t.Fatal("opened the browser with credentials")
	}
	c.Quit()
	<-ui.exited
	if ui.last().Kind != state.Stopped {
		t.Fatalf("last %+v", ui.last())
	}
}

func TestDisconnectRevokesAndOffersConnect(t *testing.T) {
	f := newControllerFixture(t)
	f.ui.waitFor(t, state.Pairing)
	f.api.approval <- nil
	f.ui.waitFor(t, state.Connected)

	f.ui.confirms = []bool{false}
	f.choose(MenuDisconnect)
	if f.ui.last().Kind != state.Connected || len(f.api.revokes) != 0 {
		t.Fatal("a cancelled disconnect disconnected")
	}

	f.ui.confirms = []bool{true}
	f.choose(MenuDisconnect)
	revoked := f.ui.waitFor(t, state.Revoked)
	if len(f.api.revokes) != 1 || f.api.revokes[0] != testToken {
		t.Fatalf("revokes %v", f.api.revokes)
	}
	if _, err := f.paths.LoadCredentials(); !errors.Is(err, config.ErrNotLoggedIn) {
		t.Fatalf("credentials kept: %v", err)
	}
	view := ViewOf(revoked)
	if view.Status != "Not connected" || !hasItem(view, MenuConnect) || hasItem(view, MenuDisconnect) {
		t.Fatalf("view %+v", view)
	}

	// Connect… pairs again.
	f.choose(MenuConnect)
	f.ui.waitFor(t, state.Pairing)
	if len(f.api.created) != 2 {
		t.Fatalf("pairings %d", len(f.api.created))
	}
}

func TestDisconnectRemovesCredentialsWhenAIQSACannotBeReached(t *testing.T) {
	f := newControllerFixture(t)
	f.ui.waitFor(t, state.Pairing)
	f.api.approval <- nil
	f.ui.waitFor(t, state.Connected)
	f.api.revokeErr = errors.New("unreachable")
	f.ui.confirms = []bool{true}
	f.choose(MenuDisconnect)
	f.ui.waitFor(t, state.Revoked)
	if _, err := f.paths.LoadCredentials(); !errors.Is(err, config.ErrNotLoggedIn) {
		t.Fatalf("credentials kept: %v", err)
	}
	if !strings.Contains(f.ui.noticeText(), "still listed there. Remove it in AIQSA → AIQSA Connect.") {
		t.Fatalf("notices %q", f.ui.noticeText())
	}
}

func TestDaemonEndsAreShown(t *testing.T) {
	cases := map[string]struct {
		err    error
		kind   state.Kind
		notice string
		exits  bool
	}{
		"revoked":    {ErrRevoked, state.Revoked, "disconnected in AIQSA", false},
		"replaced":   {ErrReplaced, state.Stopped, "Another AIQSA Connect", false},
		"failed":     {errors.New("boom"), state.Stopped, "AIQSA Connect stopped", false},
		"restarting": {ErrRestarting, state.Connected, "", true},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			f := newControllerFixture(t)
			f.ui.waitFor(t, state.Pairing)
			f.api.approval <- nil
			f.ui.waitFor(t, state.Connected)
			f.daemon.result <- tc.err
			if tc.exits {
				select {
				case <-f.ui.exited:
				case <-time.After(5 * time.Second):
					t.Fatal("did not exit for the update")
				}
				return
			}
			f.ui.waitFor(t, tc.kind)
			if !strings.Contains(f.ui.noticeText(), tc.notice) {
				t.Fatalf("notices %q", f.ui.noticeText())
			}
			if strings.Contains(f.ui.noticeText(), "boom") {
				t.Fatal("error detail shown")
			}
		})
	}
}

func TestPairingFailuresStopWithAMessage(t *testing.T) {
	cases := map[string]struct {
		prepare func(*fakeDeviceAPI)
		notice  string
	}{
		"unreachable": {func(a *fakeDeviceAPI) { a.createErr = errors.New("dial tcp: refused") }, "Cannot reach AIQSA at ai.example.com"},
		"turned off": {func(a *fakeDeviceAPI) {
			a.createErr = &api.Error{Status: 403, Code: protocol.CodeDisabled}
		}, "AIQSA Connect is turned off on ai.example.com"},
		"foreign approval page": {func(a *fakeDeviceAPI) { a.verifyURI = "https://evil.example/connect/pair" }, "approval page elsewhere"},
		"denied":                {func(a *fakeDeviceAPI) { a.approval <- api.ErrPairingDenied }, "denied in AIQSA"},
		"expired":               {func(a *fakeDeviceAPI) { a.approval <- api.ErrPairingExpired }, "The code expired"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			ui := newFakeUI()
			fake := &fakeDeviceAPI{origin: testOrigin, approval: make(chan error, 1)}
			tc.prepare(fake)
			dir := t.TempDir()
			c := &Controller{Origin: testOrigin, UI: ui, Daemon: (&fakeDaemon{}).run,
				Paths: config.Paths{ConfigDir: filepath.Join(dir, "c"), StateDir: filepath.Join(dir, "s")},
				API:   func(string, string) DeviceAPI { return fake }}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			c.Start(ctx)
			deadline := time.Now().Add(5 * time.Second)
			for !strings.Contains(ui.noticeText(), tc.notice) {
				if time.Now().After(deadline) {
					t.Fatalf("notices %q", ui.noticeText())
				}
				time.Sleep(time.Millisecond)
			}
			if last := ui.last(); last.Kind != state.Stopped {
				t.Fatalf("last %+v", last)
			}
			if name == "foreign approval page" && len(ui.opened) != 0 {
				t.Fatal("opened a foreign page")
			}
			c.stopSession()
		})
	}
}

func TestQuitWhilePairingEndsTheTray(t *testing.T) {
	f := newControllerFixture(t)
	f.ui.waitFor(t, state.Pairing)
	f.choose(MenuQuit)
	select {
	case <-f.ui.exited:
	case <-time.After(5 * time.Second):
		t.Fatal("did not exit")
	}
	if f.daemon.count() != 0 {
		t.Fatal("the daemon ran")
	}
	// A late Connect… after Quit does nothing.
	f.controller.startSession()
	if f.controller.done != nil {
		t.Fatal("a session started after Quit")
	}
}

func hasItem(view View, id MenuID) bool {
	for _, item := range view.Menu {
		if item.ID == id {
			return true
		}
	}
	return false
}

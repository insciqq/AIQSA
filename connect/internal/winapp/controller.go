package winapp

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"sync"

	"github.com/insciqq/AIQSA/connect/internal/api"
	"github.com/insciqq/AIQSA/connect/internal/config"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/state"
)

// Errors a DaemonFunc returns for the ends the tray handles itself.
var (
	// ErrRevoked: AIQSA no longer knows this device. The DaemonFunc has set
	// its credentials aside, so Connect… pairs again.
	ErrRevoked = errors.New("this computer was revoked in AIQSA")
	// ErrReplaced: another client connected with the same credentials.
	ErrReplaced = errors.New("another AIQSA Connect is connected as this computer")
	// ErrRestarting: an update was installed and the new version has been
	// started; this process must exit.
	ErrRestarting = errors.New("restarting with the updated AIQSA Connect")
)

// DaemonFunc keeps creds connected until ctx ends or a final stop, and
// reports every state change to sink. It returns nil when ctx ends.
type DaemonFunc func(ctx context.Context, creds config.Credentials, sink state.Sink) error

// DeviceAPI is the part of api.Client the tray uses.
type DeviceAPI interface {
	CreatePairing(ctx context.Context, req protocol.PairingCreateRequest) (*protocol.PairingCreateResponse, error)
	WaitForApproval(ctx context.Context, pairing *protocol.PairingCreateResponse, opts api.PairOptions) (api.Approved, error)
	RevokeSelf(ctx context.Context) error
}

// Device is what a pairing tells AIQSA about this computer.
type Device struct {
	Name, Hostname string
	OS             protocol.OS
	Arch           protocol.Arch
}

// UI is the tray as the controller drives it. Show and Notify may be
// called from any goroutine and must not block; Confirm blocks until the
// user answers.
type UI interface {
	Show(state.State)
	// Notify shows a short message beside the tray icon.
	Notify(text string)
	Confirm(title, text string) bool
	// Warn shows a message box and blocks until the user closes it.
	Warn(title, text string)
	OpenURL(url string) error
	// Exit ends the tray; the process exits.
	Exit()
}

// Controller runs the tray's connection (spec §9 steps 4-6): without
// credentials it pairs through the browser, with them it keeps the daemon
// connected, and it carries out the menu's commands.
type Controller struct {
	// Origin is the AIQSA the program was installed for; pairing uses it.
	Origin  string
	Version string
	Device  Device
	Paths   config.Paths
	// API is the device API of origin, with a device token or without.
	API         func(origin, token string) DeviceAPI
	Daemon      DaemonFunc
	UI          UI
	PairOptions api.PairOptions
	// Installed is the installed program when this copy runs from the
	// installed location; nil otherwise. The menu then offers Start at
	// sign-in and Uninstall.
	Installed *Installer

	actions  sync.Mutex // one menu command at a time
	mu       sync.Mutex
	base     context.Context
	cancel   context.CancelFunc
	done     chan struct{}
	last     state.State
	quitting bool
}

// Start begins connecting; ctx ends everything.
func (c *Controller) Start(ctx context.Context) {
	c.mu.Lock()
	c.base = ctx
	c.mu.Unlock()
	c.report(state.State{Kind: state.Stopped, Origin: c.Origin})
	c.startSession()
}

// Choose carries out a menu command in the background, so the tray's
// window keeps answering while a command waits for the user or AIQSA.
func (c *Controller) Choose(id MenuID) { go c.Do(id) }

// Do carries out a menu command; commands run one at a time.
func (c *Controller) Do(id MenuID) {
	c.actions.Lock()
	defer c.actions.Unlock()
	switch id {
	case MenuOpen:
		c.OpenAIQSA()
	case MenuConnect:
		c.startSession()
	case MenuDisconnect:
		c.Disconnect()
	case MenuQuit:
		c.Quit()
	case MenuStartAtSignIn:
		c.ToggleStartAtSignIn()
	case MenuUninstall:
		c.StartUninstall()
	}
}

// AppItems are the installed program's menu lines, read from the registry
// each time the menu opens.
func (c *Controller) AppItems() AppItems {
	if c.Installed == nil {
		return AppItems{}
	}
	return AppItems{Installed: true, StartAtSignIn: c.Installed.StartsAtSignIn()}
}

// ToggleStartAtSignIn turns the start at sign-in off when it points at the
// installed program, otherwise on. A failure leaves it as it was.
func (c *Controller) ToggleStartAtSignIn() {
	if c.Installed == nil {
		return
	}
	on := !c.Installed.StartsAtSignIn()
	if err := c.Installed.SetStartAtSignIn(on); err != nil {
		change := "turned off"
		if on {
			change = "turned on"
		}
		c.UI.Warn(AppName, fmt.Sprintf("Start at sign-in could not be %s: %v", change, err))
	}
}

// StartUninstall starts the removal as its own process, which asks the
// user and, when they agree, stops this tray like any other running copy.
func (c *Controller) StartUninstall() {
	if c.Installed == nil {
		return
	}
	if err := c.Installed.StartUninstall(); err != nil {
		c.UI.Warn(AppName, fmt.Sprintf("The removal of AIQSA Connect could not start: %v", err))
	}
}

// Current is the last reported state.
func (c *Controller) Current() state.State {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.last
}

// report is the daemon's and the pairing's Sink.
func (c *Controller) report(s state.State) {
	c.mu.Lock()
	if s.Origin == "" {
		s.Origin = c.Origin
	}
	c.last = s
	c.mu.Unlock()
	c.UI.Show(s)
}

func (c *Controller) startSession() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.done != nil || c.quitting || c.base == nil {
		return
	}
	ctx, cancel := context.WithCancel(c.base)
	done := make(chan struct{})
	c.cancel, c.done = cancel, done
	go func() {
		defer func() {
			c.mu.Lock()
			if c.done == done {
				c.cancel, c.done = nil, nil
			}
			c.mu.Unlock()
			cancel()
			close(done)
		}()
		c.session(ctx)
	}()
}

// stopSession ends pairing or the daemon and waits for it.
func (c *Controller) stopSession() {
	c.mu.Lock()
	cancel, done := c.cancel, c.done
	c.mu.Unlock()
	if cancel != nil {
		cancel()
		<-done
	}
}

func (c *Controller) session(ctx context.Context) {
	creds, err := c.Paths.LoadCredentials()
	if err != nil {
		if !errors.Is(err, config.ErrNotLoggedIn) {
			c.UI.Notify("The saved connection of this computer cannot be used. Approve this computer again.")
		}
		var ok bool
		if creds, ok = c.pair(ctx); !ok {
			return
		}
	}
	c.report(state.State{Kind: state.Connecting, Origin: creds.Origin})
	err = c.Daemon(ctx, creds, c.report)
	if ctx.Err() != nil {
		return
	}
	switch {
	case errors.Is(err, ErrRestarting):
		c.mu.Lock()
		c.quitting = true
		c.mu.Unlock()
		c.UI.Exit()
	case errors.Is(err, ErrRevoked):
		c.report(state.State{Kind: state.Revoked, Origin: creds.Origin})
		c.UI.Notify("This computer was disconnected in AIQSA. Choose Connect… to connect it again.")
	case errors.Is(err, ErrReplaced):
		c.report(state.State{Kind: state.Stopped, Origin: creds.Origin})
		c.UI.Notify("Another AIQSA Connect is connected as this computer, so this one stopped.")
	case err != nil:
		c.report(state.State{Kind: state.Stopped, Origin: creds.Origin})
		c.UI.Notify("AIQSA Connect stopped. Choose Connect… to try again.")
	default:
		c.report(state.State{Kind: state.Stopped, Origin: creds.Origin})
	}
}

// pair connects this computer: AIQSA opens in the browser on the approval
// page, the tray shows the code, and the approved token is saved.
func (c *Controller) pair(ctx context.Context) (config.Credentials, bool) {
	origin := c.Origin
	stopped := func(message string) (config.Credentials, bool) {
		if ctx.Err() == nil {
			c.report(state.State{Kind: state.Stopped, Origin: origin})
			if message != "" {
				c.UI.Notify(message)
			}
		}
		return config.Credentials{}, false
	}
	if origin == "" {
		return stopped(downloadAgainText)
	}
	client := c.API(origin, "")
	c.report(state.State{Kind: state.Connecting, Origin: origin})
	pairing, err := client.CreatePairing(ctx, protocol.PairingCreateRequest{
		Name: c.Device.Name, Hostname: c.Device.Hostname, OS: c.Device.OS, Arch: c.Device.Arch, ClientVersion: c.Version,
	})
	if err != nil {
		return stopped(pairingFailure(origin, err))
	}
	if !sameOrigin(pairing.VerificationURI, origin) {
		return stopped(fmt.Sprintf("AIQSA at %s answered with an approval page elsewhere, so it was not opened.", Host(origin)))
	}
	c.report(state.State{Kind: state.Pairing, Origin: origin, UserCode: pairing.UserCode, VerificationURI: pairing.VerificationURI})
	if err := c.UI.OpenURL(pairing.VerificationURI); err != nil {
		c.UI.Notify("Open " + pairing.VerificationURI + " and approve this computer with the code " + pairing.UserCode + ".")
	}
	approved, err := client.WaitForApproval(ctx, pairing, c.PairOptions)
	switch {
	case ctx.Err() != nil:
		return config.Credentials{}, false
	case errors.Is(err, api.ErrPairingDenied):
		return stopped("This computer was denied in AIQSA.")
	case errors.Is(err, api.ErrPairingExpired):
		return stopped("The code expired before it was approved. Choose Connect… for a new one.")
	case err != nil:
		return stopped(pairingFailure(origin, err))
	}
	creds := config.Credentials{Origin: origin, DeviceID: approved.DeviceID, DeviceToken: approved.DeviceToken}
	if err := c.Paths.SaveCredentials(creds); err != nil {
		return stopped("The connection could not be saved on this computer.")
	}
	// The approving account, so a code someone else approved first does not go unnoticed.
	c.UI.Notify(truncateUTF16(fmt.Sprintf("Connected to %s for %s.", Host(origin), approved.Account), 255))
	return creds, true
}

// pairingFailure explains a failed pairing request without the server's body.
func pairingFailure(origin string, err error) string {
	host := Host(origin)
	if errors.Is(err, api.ErrPlainHTTPNotLocal) {
		return fmt.Sprintf("%s is outside your local network, where http:// is refused. Download AIQSA Connect from an https:// address.", host)
	}
	apiErr, ok := api.AsError(err)
	if !ok {
		return fmt.Sprintf("Cannot reach AIQSA at %s. Choose Connect… to try again.", host)
	}
	switch apiErr.Code {
	case protocol.CodeDisabled:
		return fmt.Sprintf("AIQSA Connect is turned off on %s. Ask its administrator to turn it on.", host)
	case protocol.CodeRateLimited:
		return "Too many attempts. Try again in a few minutes."
	case protocol.CodeClientOutdated:
		return fmt.Sprintf("This AIQSA Connect is too old for %s. Download it again from your AIQSA page.", host)
	}
	return fmt.Sprintf("AIQSA at %s refused the request (%s).", host, apiErr.LogCode())
}

// sameOrigin reports whether link is an address on origin.
func sameOrigin(link, origin string) bool {
	u, err := url.Parse(link)
	if err != nil || u.User != nil {
		return false
	}
	return u.Scheme+"://"+u.Host == origin
}

// OpenAIQSA opens the approval page while pairing, otherwise AIQSA.
func (c *Controller) OpenAIQSA() {
	current := c.Current()
	target := current.Origin
	if current.Kind == state.Pairing && current.VerificationURI != "" {
		target = current.VerificationURI
	}
	if target == "" {
		return
	}
	if err := c.UI.OpenURL(target); err != nil {
		c.UI.Notify("Cannot open " + Host(target) + " in the browser.")
	}
}

// Disconnect revokes this computer after the user confirms (spec D-16):
// the daemon stops, AIQSA deletes the device, and the credentials are
// removed even when AIQSA cannot be reached.
func (c *Controller) Disconnect() {
	host := Host(c.Current().Origin)
	text := fmt.Sprintf("Disconnect this computer from %s?\n\nThe AIQSA agent can then no longer work on it. You can connect it again from this menu.", host)
	if !c.UI.Confirm("Disconnect this computer", text) {
		return
	}
	c.stopSession()
	creds, err := c.Paths.LoadCredentials()
	origin := c.Origin
	if err == nil {
		origin = creds.Origin
		ctx, cancel := context.WithTimeout(context.Background(), RevokeTimeout)
		revokeErr := c.API(creds.Origin, creds.DeviceToken).RevokeSelf(ctx)
		cancel()
		if revokeErr != nil {
			c.UI.Notify(fmt.Sprintf("AIQSA at %s could not be reached, so this computer is still listed there. Remove it in AIQSA → AIQSA Connect.", Host(creds.Origin)))
		}
	}
	if !errors.Is(err, config.ErrNotLoggedIn) {
		c.Paths.RemoveCredentials()
	}
	c.report(state.State{Kind: state.Revoked, Origin: origin})
}

// Quit stops the connection and ends the tray until the next sign-in.
func (c *Controller) Quit() {
	c.mu.Lock()
	c.quitting = true
	c.mu.Unlock()
	c.stopSession()
	c.report(state.State{Kind: state.Stopped})
	c.UI.Exit()
}

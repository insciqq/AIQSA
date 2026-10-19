package daemon

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/tmux"
)

// ErrInvalidStatus is returned by ReportStatus for values outside the contract.
var ErrInvalidStatus = errors.New("invalid session status")

// ReportStatus records a session's status: it sets the tmux user options
// @aiqsa_status and @aiqsa_status_at, sends a `status` event (with reason,
// when not empty) and refreshes the snapshot. Nothing happens when the
// status is unchanged. Without a stream only the tmux options change; the
// next snapshot carries them. A bell sets a status only in a Claude Code or
// Codex session: in a shell it is a beep (an ambiguous Tab) that nothing
// would ever clear. It returns tmux.ErrSessionNotFound for an unknown
// session.
func (d *Daemon) ReportStatus(sessionID string, status protocol.SessionStatus, reason protocol.StatusReason) error {
	if !protocol.SessionIDRegexp.MatchString(sessionID) || !slices.Contains(protocol.SessionStatuses, status) ||
		reason != "" && !slices.Contains(protocol.StatusReasons, reason) {
		return ErrInvalidStatus
	}
	d.reportMu.Lock()
	defer d.reportMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if reason == protocol.ReasonBell {
		program, err := d.tmux.Option(ctx, sessionID, tmux.OptionProgram)
		if err != nil {
			return err
		}
		if !isAgent(protocol.Program(program)) {
			d.log.Event("bell_ignored", "cause", "not_agent")
			return nil
		}
	}
	current, known := d.cachedStatus(sessionID)
	if !known {
		value, err := d.tmux.Option(ctx, sessionID, tmux.OptionStatus)
		if err != nil {
			return err
		}
		current = protocol.SessionStatus(value)
	}
	if current == status {
		d.setCachedStatus(sessionID, status)
		return nil
	}
	at := protocol.FormatTimestamp(time.Now())
	if err := d.tmux.SetOptions(ctx, sessionID, tmux.OptionStatus, string(status), tmux.OptionStatusAt, at); err != nil {
		return err
	}
	d.setCachedStatus(sessionID, status)
	d.log.Event("status", "status", status, "reason", reason)
	if c := d.current(); c != nil {
		event := &protocol.StatusEvent{Type: protocol.EventStatus, SessionID: sessionID, Status: status, StatusAt: at}
		if reason != "" {
			event.Reason = &reason
		}
		c.push(event)
		c.kickSnapshot()
	}
	return nil
}

// reportInput marks an agent session running after input from a view,
// without blocking the stream when it already is. Views call it only for
// agent sessions: a shell has no turns, so its status stays as reported.
func (d *Daemon) reportInput(sessionID string) {
	if status, known := d.cachedStatus(sessionID); known && status == protocol.StatusRunning {
		return
	}
	go func() {
		if err := d.ReportStatus(sessionID, protocol.StatusRunning, protocol.ReasonInput); err != nil {
			d.log.Event("status_failed", "err", err)
		}
	}()
}

func (d *Daemon) cachedStatus(sessionID string) (protocol.SessionStatus, bool) {
	d.statusMu.Lock()
	defer d.statusMu.Unlock()
	status, known := d.status[sessionID]
	return status, known
}

func (d *Daemon) setCachedStatus(sessionID string, status protocol.SessionStatus) {
	d.statusMu.Lock()
	defer d.statusMu.Unlock()
	d.status[sessionID] = status
}

func (d *Daemon) forgetStatus(sessionID string) {
	d.statusMu.Lock()
	defer d.statusMu.Unlock()
	delete(d.status, sessionID)
}

// seedStatus learns the status of sessions seen for the first time and
// forgets sessions that are gone. Known entries are kept: ReportStatus is
// their only writer.
func (d *Daemon) seedStatus(list []tmux.Session) {
	d.statusMu.Lock()
	defer d.statusMu.Unlock()
	present := make(map[string]bool, len(list))
	for _, s := range list {
		present[s.ID] = true
		if _, known := d.status[s.ID]; !known {
			status := protocol.SessionStatus(s.Status)
			if !slices.Contains(protocol.SessionStatuses, status) {
				status = protocol.StatusIdle
			}
			d.status[s.ID] = status
		}
	}
	for id := range d.status {
		if !present[id] {
			delete(d.status, id)
		}
	}
}

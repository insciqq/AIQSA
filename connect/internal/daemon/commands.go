package daemon

import (
	"context"
	"errors"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/api"
	"github.com/insciqq/AIQSA/connect/internal/protocol"
	"github.com/insciqq/AIQSA/connect/internal/tmux"
)

// handleCommand runs one server command. View commands run in stream order
// on the stream goroutine; request commands run concurrently and reply.
func (c *connection) handleCommand(data []byte) {
	command, err := protocol.DecodeServerCommand(data)
	if err != nil {
		var unknown *protocol.UnknownCommandError
		if errors.As(err, &unknown) {
			c.d.log.Event("command_unknown", "answered", unknown.RequestID != "")
			if unknown.RequestID != "" {
				c.push(protocol.NewReplyError(unknown.RequestID, protocol.CodeUnsupported))
			}
			return
		}
		c.d.log.Event("command_invalid")
		return
	}
	switch m := command.(type) {
	case *protocol.ViewOpen:
		c.d.log.Event("command", "type", m.CommandType())
		c.openView(m)
	case *protocol.ViewInput:
		c.viewInput(m)
	case *protocol.ViewResize:
		c.viewResize(m)
	case *protocol.ViewClose:
		c.d.log.Event("command", "type", m.CommandType())
		if v := c.viewByID(m.ViewID); v != nil {
			c.closeView(v, "")
		}
	case protocol.RequestCommand:
		c.d.log.Event("command", "type", m.CommandType())
		c.wg.Go(func() { c.answer(m) })
	}
}

// replyBudget leaves a margin under the server's reply timeout.
func (c *connection) replyBudget() time.Duration {
	return max(time.Duration(c.limits.ReplyTimeoutSeconds)*time.Second-time.Second, time.Second)
}

func (c *connection) answer(command protocol.RequestCommand) {
	ctx, cancel := context.WithTimeout(c.ctx, c.replyBudget())
	defer cancel()
	requestID := command.CommandRequestID()
	result, code := c.execute(ctx, command)
	if c.ctx.Err() != nil {
		return
	}
	if code != "" {
		c.d.log.Event("reply", "type", command.CommandType(), "code", code)
		c.push(protocol.NewReplyError(requestID, code))
		return
	}
	reply, err := c.encodeReply(requestID, command, result)
	if err != nil {
		c.d.log.Event("reply", "type", command.CommandType(), "code", protocol.CodeDeviceError)
		c.push(protocol.NewReplyError(requestID, protocol.CodeDeviceError))
		return
	}
	c.d.log.Event("reply", "type", command.CommandType(), "ok", true)
	c.out.push(&outItem{data: reply})
}

// encodeReply builds a successful reply that fits one batch body; a
// history text is shortened until it does.
func (c *connection) encodeReply(requestID string, command protocol.RequestCommand, result protocol.Validator) ([]byte, error) {
	for range 8 {
		if err := result.Validate(); err != nil {
			return nil, err
		}
		encoded, err := api.Marshal(result)
		if err != nil {
			return nil, err
		}
		reply := &protocol.ReplyEvent{Type: protocol.EventReply, RequestID: requestID, OK: true, Result: encoded}
		if err := reply.Validate(); err != nil {
			return nil, err
		}
		data, err := api.Marshal(reply)
		if err != nil {
			return nil, err
		}
		excess := len(data) + api.BatchOverhead - c.maxBatchBytes()
		if excess <= 0 {
			return data, nil
		}
		history, ok := result.(*protocol.SessionHistoryResult)
		if !ok {
			return nil, errors.New("reply too large")
		}
		history.Text = tmux.FitHistory(history.Text, max(len(history.Text)-excess-64, 0))
	}
	return nil, errors.New("reply too large")
}

func codeOf(err error) protocol.ReasonCode {
	if errors.Is(err, tmux.ErrSessionNotFound) {
		return protocol.CodeSessionNotFound
	}
	return protocol.CodeDeviceError
}

func (c *connection) execute(ctx context.Context, command protocol.RequestCommand) (protocol.Validator, protocol.ReasonCode) {
	d := c.d
	switch m := command.(type) {
	case *protocol.SessionCreate:
		cwd, err := tmux.ResolveCwd(m.Cwd, d.home)
		if err != nil || sanitizePath(cwd) != cwd {
			return nil, protocol.CodeCwdInvalid
		}
		title := DefaultTitle(m.Program, cwd)
		if m.Title != nil {
			if given := tmux.SanitizeText(*m.Title, protocol.MaxTitleLength); given != "" {
				title = given
			}
		}
		id, code := c.createSession(ctx, tmux.CreateOptions{Program: m.Program, Cwd: cwd, Title: title})
		if code != "" {
			return nil, code
		}
		if err := d.recent.add(cwd); err != nil {
			d.log.Event("recent_dirs_failed", "err", err)
		}
		c.sendSnapshot(false)
		return &protocol.SessionCreateResult{SessionID: id}, ""
	case *protocol.SessionKill:
		if exists, err := d.tmux.Exists(ctx, m.SessionID); err != nil || !exists {
			if err != nil {
				return nil, protocol.CodeDeviceError
			}
			return nil, protocol.CodeSessionNotFound
		}
		if err := d.tmux.Kill(ctx, m.SessionID); err != nil {
			return nil, codeOf(err)
		}
		d.forgetStatus(m.SessionID)
		c.sendSnapshot(false)
		return &protocol.SessionKillResult{}, ""
	case *protocol.SessionHistory:
		if exists, err := d.tmux.Exists(ctx, m.SessionID); err != nil || !exists {
			return nil, existsCode(err)
		}
		text, err := d.tmux.CaptureHistory(ctx, m.SessionID)
		if err != nil {
			return nil, codeOf(err)
		}
		return &protocol.SessionHistoryResult{Text: tmux.FitHistory(text, c.limits.MaxHistoryBytes)}, ""
	case *protocol.SessionOptions:
		if exists, err := d.tmux.Exists(ctx, m.SessionID); err != nil || !exists {
			return nil, existsCode(err)
		}
		screen, err := d.tmux.CaptureScreen(ctx, m.SessionID)
		if err != nil {
			return nil, codeOf(err)
		}
		options := tmux.ParseOptions(screen)
		if options == nil {
			options = []protocol.SessionOption{}
		}
		return &protocol.SessionOptionsResult{Options: options}, ""
	case *protocol.RecentDirs:
		return &protocol.RecentDirsResult{Home: d.home, Dirs: d.recent.list(d.home, c.limits.MaxRecentDirs)}, ""
	}
	return nil, protocol.CodeUnsupported
}

// createSession counts the sessions and creates one while holding the
// daemon's create slot; other request commands stay concurrent.
func (c *connection) createSession(ctx context.Context, opts tmux.CreateOptions) (string, protocol.ReasonCode) {
	d := c.d
	select {
	case d.createSlot <- struct{}{}:
	case <-ctx.Done():
		return "", protocol.CodeDeviceError
	}
	defer func() { <-d.createSlot }()
	list, err := d.tmux.List(ctx)
	if err != nil {
		return "", protocol.CodeDeviceError
	}
	if len(list) >= c.limits.MaxSessions {
		return "", protocol.CodeSessionLimit
	}
	id, err := d.tmux.Create(ctx, opts)
	if err != nil {
		d.log.Event("session_create_failed", "err", err)
		return "", protocol.CodeDeviceError
	}
	d.setCachedStatus(id, protocol.StatusIdle)
	return id, ""
}

func existsCode(err error) protocol.ReasonCode {
	if err != nil {
		return protocol.CodeDeviceError
	}
	return protocol.CodeSessionNotFound
}

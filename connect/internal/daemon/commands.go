package daemon

import (
	"errors"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// handleCommand runs one server command: an op starts in the background,
// cancel and run_ended stop ops and jobs. It runs on the stream goroutine
// and never blocks.
func (c *connection) handleCommand(data []byte) {
	command, err := protocol.DecodeServerCommandV2(data)
	if err != nil {
		var unknown *protocol.UnknownCommandError
		if errors.As(err, &unknown) {
			c.d.log.Event("command_unknown", "answered", unknown.RequestID != "")
			if unknown.RequestID != "" {
				c.push(protocol.NewOpReplyError(unknown.RequestID, protocol.CodeUnsupported))
			}
			return
		}
		c.d.log.Event("command_invalid")
		return
	}
	switch m := command.(type) {
	case *protocol.OpCommand:
		c.d.exec.Start(m, c.d.pushReply)
	case *protocol.CancelCommand:
		c.d.log.Event("command", "type", m.CommandType())
		c.d.exec.Cancel(m.RequestID)
	case *protocol.RunEndedCommand:
		c.d.log.Event("command", "type", m.CommandType())
		c.d.exec.EndRun(m.RunID)
	}
}

// pushReply sends an op's reply on the current stream; with none, the
// server stopped waiting for it and it is dropped.
func (d *Daemon) pushReply(reply *protocol.OpReplyEvent) {
	if conn := d.current(); conn != nil {
		conn.push(reply)
		return
	}
	d.log.Event("reply_dropped", "reason", "offline")
}

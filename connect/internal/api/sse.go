package api

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// MaxEventBytes bounds one SSE event's data (a view_input command carries at
// most 64 KiB of input, which JSON escaping can grow several times).
const MaxEventBytes = 4 << 20

// ErrEventTooLarge is returned for an SSE event above MaxEventBytes.
var ErrEventTooLarge = errors.New("stream event too large")

// Event is one dispatched SSE event.
type Event struct {
	Name string
	Data []byte
}

// SSEReader parses a text/event-stream: `event:` and `data:` fields,
// multi-line data, comments and blank-line dispatch. `id:` and `retry:` are
// ignored.
type SSEReader struct {
	r   *bufio.Reader
	max int
}

// NewSSEReader reads events from r.
func NewSSEReader(r io.Reader) *SSEReader {
	return &SSEReader{r: bufio.NewReaderSize(r, 64<<10), max: MaxEventBytes}
}

// Next returns the next event with data. It returns io.EOF when the stream
// ends; an event that was not terminated by a blank line is dropped.
func (s *SSEReader) Next() (Event, error) {
	var name string
	var data bytes.Buffer
	hasData := false
	size := 0
	for {
		line, err := s.readLine(&size)
		if err != nil {
			return Event{}, err
		}
		if len(line) == 0 {
			if hasData {
				if name == "" {
					name = "message"
				}
				return Event{Name: name, Data: data.Bytes()}, nil
			}
			name, size = "", 0
			continue
		}
		if line[0] == ':' {
			continue
		}
		field, value, found := bytes.Cut(line, []byte(":"))
		if found && len(value) > 0 && value[0] == ' ' {
			value = value[1:]
		}
		switch string(field) {
		case "event":
			name = string(value)
		case "data":
			if hasData {
				data.WriteByte('\n')
			}
			data.Write(value)
			hasData = true
		}
	}
}

// readLine returns one line without its terminator, counting its size
// against the event limit.
func (s *SSEReader) readLine(size *int) ([]byte, error) {
	var line []byte
	for {
		chunk, err := s.r.ReadSlice('\n')
		*size += len(chunk)
		if *size > s.max {
			return nil, ErrEventTooLarge
		}
		line = append(line, chunk...)
		if err == nil {
			break
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if errors.Is(err, io.EOF) && len(line) > 0 {
			return nil, io.ErrUnexpectedEOF
		}
		return nil, err
	}
	line = bytes.TrimSuffix(line, []byte("\n"))
	return bytes.TrimSuffix(line, []byte("\r")), nil
}

// Stream is an open device stream.
type Stream struct {
	body   io.ReadCloser
	reader *SSEReader
}

// Next returns the next event.
func (s *Stream) Next() (Event, error) { return s.reader.Next() }

// Close closes the stream.
func (s *Stream) Close() error { return s.body.Close() }

// OpenStream opens GET /connect-api/v1/stream. The stream lives until ctx
// is cancelled or the server closes it.
func (c *Client) OpenStream(ctx context.Context) (*Stream, error) {
	req, err := c.newRequest(ctx, http.MethodGet, protocol.DeviceStreamPath, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")
	resp, err := c.do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, responseError(resp)
	}
	return &Stream{body: resp.Body, reader: NewSSEReader(resp.Body)}, nil
}

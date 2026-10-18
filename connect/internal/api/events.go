package api

import (
	"bytes"
	"context"
	"io"
	"net/http"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// BatchOverhead is the size of `{"events":[` and `]}` around the events.
const BatchOverhead = len(`{"events":[]}`)

// BatchBody joins already encoded events into a POST /events body.
func BatchBody(events [][]byte) []byte {
	var buf bytes.Buffer
	buf.WriteString(`{"events":[`)
	for i, event := range events {
		if i > 0 {
			buf.WriteByte(',')
		}
		buf.Write(event)
	}
	buf.WriteString(`]}`)
	return buf.Bytes()
}

// PostEvents posts one batch body; 204 is success.
func (c *Client) PostEvents(ctx context.Context, body []byte) error {
	ctx, cancel := context.WithTimeout(ctx, RequestTimeout)
	defer cancel()
	req, err := c.newRequest(ctx, http.MethodPost, protocol.DeviceEventsPath, nil)
	if err != nil {
		return err
	}
	req.Body = io.NopCloser(bytes.NewReader(body))
	req.ContentLength = int64(len(body))
	req.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(body)), nil }
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		return responseError(resp)
	}
	io.Copy(io.Discard, io.LimitReader(resp.Body, maxErrorBodyBytes))
	resp.Body.Close()
	return nil
}

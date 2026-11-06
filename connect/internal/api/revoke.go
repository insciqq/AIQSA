package api

import (
	"context"
	"errors"
	"io"
	"net/http"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// DeviceSelfPath is the calling device itself: DELETE removes it, as Revoke
// does in the browser (spec D-16).
const DeviceSelfPath = protocol.DeviceAPIPrefix + "/device"

// ErrNoDeviceToken refuses a self-revoke without a device token.
var ErrNoDeviceToken = errors.New("this computer has no device token to revoke")

// RevokeSelf deletes this device in AIQSA: DELETE /connect-api/v1/device
// with the device token. A device AIQSA no longer knows (401) counts as
// revoked, so a repeated call succeeds. Any other refusal or a network
// failure is returned and the device may still exist.
func (c *Client) RevokeSelf(ctx context.Context) error {
	if c.Token == "" {
		return ErrNoDeviceToken
	}
	ctx, cancel := context.WithTimeout(ctx, RequestTimeout)
	defer cancel()
	req, err := c.newRequest(ctx, http.MethodDelete, DeviceSelfPath, nil)
	if err != nil {
		return err
	}
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		io.Copy(io.Discard, io.LimitReader(resp.Body, maxErrorBodyBytes))
		resp.Body.Close()
		return nil
	case resp.StatusCode == http.StatusUnauthorized:
		// The token no longer opens a device: it was revoked already.
		resp.Body.Close()
		return nil
	}
	return responseError(resp)
}

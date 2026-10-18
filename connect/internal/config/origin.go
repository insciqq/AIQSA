package config

import (
	"errors"
	"net"
	"net/url"
	"strconv"
	"strings"
)

// NormalizeOrigin validates an AIQSA address and returns it as
// scheme://host[:port]. Only https is accepted, except plain http for
// loopback hosts (localhost, 127.0.0.0/8, ::1) used in development. Paths
// other than "/", queries, fragments and user info are refused.
func NormalizeOrigin(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("the AIQSA address is empty")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Opaque != "" {
		return "", errors.New("the AIQSA address is not a valid URL")
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "https" && scheme != "http" {
		return "", errors.New("the AIQSA address must start with https://")
	}
	if u.User != nil {
		return "", errors.New("the AIQSA address must not contain a user name or password")
	}
	if u.Path != "" && u.Path != "/" || u.RawPath != "" {
		return "", errors.New("the AIQSA address must not contain a path; use only https://host[:port]")
	}
	if u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(raw, "#") {
		return "", errors.New("the AIQSA address must not contain a query or fragment")
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return "", errors.New("the AIQSA address has no host")
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return "", errors.New("the AIQSA address has an invalid port")
		}
	} else if strings.HasSuffix(u.Host, ":") {
		return "", errors.New("the AIQSA address has an invalid port")
	}
	if scheme == "http" && !isLoopbackHost(host) {
		return "", errors.New("the AIQSA address must use https:// (http:// is allowed only for localhost)")
	}
	return scheme + "://" + strings.ToLower(u.Host), nil
}

func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

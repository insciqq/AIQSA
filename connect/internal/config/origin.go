package config

import (
	"errors"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
)

// NormalizeOrigin validates an AIQSA address and returns it as
// scheme://host[:port]. Plain http is accepted for host names and for IP
// addresses on the local network (see IsLocalIP); the api transport also
// checks every address a host name resolves to (operator decision
// 2026-10-19). Paths other than "/", queries, fragments and user info are
// refused.
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
	if strings.Contains(host, "%") {
		return "", errors.New("the AIQSA address must not contain an IPv6 zone")
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return "", errors.New("the AIQSA address has an invalid port")
		}
	} else if strings.HasSuffix(u.Host, ":") {
		return "", errors.New("the AIQSA address has an invalid port")
	}
	if ip, err := netip.ParseAddr(host); scheme == "http" && err == nil && !IsLocalIP(ip) {
		return "", errors.New("the AIQSA address must use https:// (http:// works only with an address on your local network)")
	}
	return scheme + "://" + strings.ToLower(u.Host), nil
}

// sharedAddressSpace is 100.64.0.0/10, the carrier-grade NAT range Tailscale
// addresses come from.
var sharedAddressSpace = netip.MustParsePrefix("100.64.0.0/10")

// IsLocalIP reports an address plain http may reach: loopback, private
// (10/8, 172.16/12, 192.168/16, fc00::/7), link-local unicast or
// 100.64.0.0/10.
func IsLocalIP(ip netip.Addr) bool {
	ip = ip.Unmap().WithZone("")
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || sharedAddressSpace.Contains(ip)
}

// IsUnencryptedOrigin reports a normalized plain http origin whose traffic
// leaves this computer.
func IsUnencryptedOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "http" {
		return false
	}
	host := u.Hostname()
	if host == "localhost" {
		return false
	}
	ip, err := netip.ParseAddr(host)
	return err != nil || !ip.Unmap().IsLoopback()
}

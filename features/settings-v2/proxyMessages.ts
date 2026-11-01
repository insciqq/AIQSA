import {
  PROXY_LIMITS,
  type ProxyAddressFailureCode,
  type ProxyChangeFailureCode,
  type ProxyConnectionFailureCode,
  type ProxyInputFailureCode
} from "@/lib/contracts/proxies";
import { PROXY_MALFORMED_RESPONSE, PROXY_NETWORK_FAILURE } from "./proxiesApi";

type ProxyFailureCode = ProxyAddressFailureCode | ProxyChangeFailureCode | ProxyConnectionFailureCode | ProxyInputFailureCode;

/** Every stable code says what happened and what to do; the type keeps the table complete. */
const FAILURES: Readonly<Record<ProxyFailureCode, string>> = {
  proxy_address_check_unavailable: "The address could not be checked right now. Try again in a minute.",
  proxy_address_forbidden: "This address is private or internal, and only a public address can be used. Enter the proxy's public host name or IP address.",
  proxy_auth_failed: "The proxy refused the login or password. Check them with the proxy's provider, and enter the password again if it changed.",
  proxy_conflict: "This proxy was changed somewhere else, so nothing was saved. The latest version is shown: look it over and try again.",
  proxy_connect_failed: "Could not connect to the proxy. Check the host and port, and that the proxy is running.",
  proxy_country_invalid: "The country must be a two-letter code such as KZ or DE. Leave it empty if it does not matter.",
  proxy_dns_failed: "This host name could not be found. Check its spelling.",
  proxy_hint_invalid: `A domain hint is not valid. Use zones such as .kz and domains such as ozon.ru, not addresses, and at most ${PROXY_LIMITS.hintsPerProxy} of them.`,
  proxy_host_invalid: "The host is not valid. Enter only a host name or IP address, such as proxy.example.com, without http:// or a port.",
  proxy_input_invalid: "This change could not be saved. Reload the page and try again.",
  proxy_limit: `You have reached the limit of ${PROXY_LIMITS.proxiesPerOwner} proxies. Delete one you no longer need, then add this one.`,
  proxy_login_invalid: `A login has no colon and fits ${PROXY_LIMITS.loginMaxLength} bytes. A password needs a login: enter one, or remove the password.`,
  proxy_name_invalid: `Enter a name of up to ${PROXY_LIMITS.nameMaxLength} characters, without line breaks.`,
  proxy_name_taken: "Another proxy already has this name. Choose a different one.",
  proxy_password_invalid: `A password fits ${PROXY_LIMITS.passwordMaxLength} bytes and has no line breaks. Enter it again.`,
  proxy_port_invalid: "The port must be a number from 1 to 65535.",
  proxy_protocol_error: "The proxy did not answer the way this protocol should. Check whether it uses HTTP, HTTPS or SOCKS5.",
  proxy_protocol_invalid: "Choose HTTP, HTTPS or SOCKS5.",
  proxy_timeout: "The proxy did not answer in time. It may be down or overloaded. Try again later, or use another proxy.",
  proxy_tls_failed: "A secure connection to the proxy failed. Check that it really uses HTTPS, or choose the protocol it does use."
};

const OTHER_FAILURES: Readonly<Record<string, string>> = {
  forbidden: "You do not have access to these proxies.",
  [PROXY_MALFORMED_RESPONSE]: "The server sent an unexpected answer. Try again.",
  [PROXY_NETWORK_FAILURE]: "The server could not be reached. Check your connection and try again.",
  proxy_not_found: "This proxy no longer exists.",
  proxy_unavailable: "Proxies are unavailable right now. Try again in a minute.",
  unauthorized: "Your session has ended. Sign in again."
};

const UNKNOWN_FAILURE = "That did not work. Try again.";

/** A code from a route or a check, in words. Own-property lookups only, because the code comes from a response. */
export function proxyFailureMessage(code: string): string {
  if (Object.hasOwn(FAILURES, code)) return FAILURES[code as ProxyFailureCode];
  return Object.hasOwn(OTHER_FAILURES, code) ? OTHER_FAILURES[code]! : UNKNOWN_FAILURE;
}

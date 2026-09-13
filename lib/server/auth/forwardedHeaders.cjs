"use strict";

// Next fills an absent X-Forwarded-For with the socket peer. Preserve missing
// identity as an empty value before that normalization, so trusted-proxy auth
// rejects it instead of placing every client in the proxy's IP bucket.
function preserveForwardedIdentity(request) {
  if (request.headers["x-forwarded-for"] === undefined) {
    request.headers["x-forwarded-for"] = "";
    request.rawHeaders.push("X-Forwarded-For", "");
  }
}

module.exports = { preserveForwardedIdentity };

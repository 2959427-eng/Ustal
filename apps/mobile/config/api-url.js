/* global URL */
// An explicit origin allowlist also rejects private IP aliases and alternative
// IP representations. Production host changes require a reviewed source change.
const PRODUCTION_API_ORIGIN = "https://api.104-171-139-154.sslip.io";
function productionApiUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Production API URL is missing or invalid"); }
  if (url.origin !== PRODUCTION_API_ORIGIN || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Production API must use the approved public HTTPS origin; local/private/dev overrides are forbidden");
  }
  return url.origin;
}
module.exports = { productionApiUrl, PRODUCTION_API_ORIGIN };

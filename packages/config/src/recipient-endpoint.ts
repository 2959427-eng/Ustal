/** Public URL identity, not filesystem normalization. Never return credential/query input on failure. */
export function canonicalRecipientEndpoint(value: string): string {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error();
    return url.href.replace(/\/$/, "");
  } catch { throw new Error("Invalid public recipient endpoint"); }
}

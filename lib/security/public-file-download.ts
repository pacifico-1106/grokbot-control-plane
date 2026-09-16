import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedV4.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
// Special-purpose, transition/tunnel and documentation space. IPv4-mapped,
// NAT64, loopback, ULA and link-local are outside the accepted global range.
blockedV6.addSubnet("2001::", 23, "ipv6");
blockedV6.addSubnet("2001:db8::", 32, "ipv6");
blockedV6.addSubnet("2002::", 16, "ipv6");
blockedV6.addSubnet("3fff::", 20, "ipv6");

export function isPublicDownloadAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blockedV4.check(address, "ipv4") :
    family === 6 && globalV6.check(address, "ipv6") && !blockedV6.check(address, "ipv6");
}

// A bounded, credential-free download. DNS is checked on every redirect and the
// selected IP is pinned to the TLS connection (Host/SNI retain the original host).
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export async function downloadPublicFile(destination: string): Promise<Buffer> {
  const signal = AbortSignal.timeout(30_000);
  let url = new URL(destination);
  for (let hop = 0; hop <= 3; hop++) {
    if (url.protocol !== "https:" || url.username || url.password || url.hash ||
        (url.port && url.port !== "443")) throw new Error("file_destination_denied");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    let cancel: (() => void) | undefined;
    const answers = await Promise.race([
      isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }]) : lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        const abort = () => reject(new Error("file_download_timeout"));
        cancel = () => signal.removeEventListener("abort", abort);
        if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      }),
    ]).finally(() => cancel?.());
    if (!answers.length || answers.some(a => !isPublicDownloadAddress(a.address))) throw new Error("file_destination_denied");
    const result = await new Promise<Buffer | URL>((resolve, reject) => {
      const req = request({
        protocol: "https:", hostname: answers[0].address, family: answers[0].family,
        port: 443, path: url.pathname + url.search, servername: isIP(hostname) ? undefined : hostname,
        method: "GET", agent: false, rejectUnauthorized: true, signal,
        headers: { host: url.host, "accept-encoding": "identity" },
      }, response => {
        const status = response.statusCode || 0;
        if ([301,302,303,307,308].includes(status)) {
          response.destroy();
          try {
            if (!response.headers.location || hop === 3) throw new Error("file_redirect_denied");
            resolve(new URL(response.headers.location, url));
          } catch { reject(new Error("file_redirect_denied")); }
          return;
        }
        if (status < 200 || status >= 300 || Number(response.headers["content-length"]) > MAX_FILE_BYTES ||
            (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")) {
          response.destroy(); reject(new Error("file_download_failed")); return;
        }
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_FILE_BYTES) { response.destroy(); reject(new Error("file_too_large")); }
          else chunks.push(chunk);
        });
        response.on("end", () => resolve(Buffer.concat(chunks)));
        response.on("aborted", () => reject(new Error("file_download_failed")));
        response.on("error", () => reject(new Error("file_download_failed")));
      });
      req.on("error", () => reject(new Error("file_download_failed")));
      req.end();
    });
    if (Buffer.isBuffer(result)) return result;
    url = result;
  }
  throw new Error("file_redirect_denied");
}

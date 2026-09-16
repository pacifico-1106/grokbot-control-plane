import { test, expect, mock, beforeEach } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
let answers = [{ address: "8.8.8.8", family: 4 }];
let replies: Array<{ status: number; headers?: Record<string,string>; chunks?: Buffer[] }> = [];
const requests: Array<Record<string, unknown>> = [];
mock.module("node:dns/promises", () => ({ lookup: async () => answers }));
mock.module("node:https", () => ({ request: (options: Record<string, unknown>, callback: (response: Readable) => void) => {
  requests.push(options);
  const req = new EventEmitter() as EventEmitter & { end: () => void };
  req.end = () => { queueMicrotask(() => {
    const reply = replies.shift();
    if (!reply) { req.emit("error", new Error("unexpected_request")); return; }
    const stream = Object.assign(Readable.from(reply.chunks || []), { statusCode: reply.status, headers: reply.headers || {} });
    callback(stream);
  }); };
  return req;
} }));
const { downloadPublicFile, isPublicDownloadAddress, MAX_FILE_BYTES } = await import("./public-file-download");
beforeEach(() => { answers = [{ address: "8.8.8.8", family: 4 }]; requests.length = 0; replies = []; });
test("public HTTPS signed URL works through redirect; socket pins inspected IP and original TLS host", async () => {
 replies = [{ status:302,headers:{ location:"https://cdn.example.com/file?signature=fixture" } },{ status:200,chunks:[Buffer.from("PDF")] }];
 expect((await downloadPublicFile("https://example.com/file")).toString()).toBe("PDF");
 expect(requests.length).toBe(2);
 expect(requests[1].hostname).toBe("8.8.8.8");
 expect(requests[1].servername).toBe("cdn.example.com");
 expect(requests[1].rejectUnauthorized).toBe(true);
 expect(requests[1].agent).toBe(false);
});
test("private, special IPv4/IPv6, URL credentials, protocols and ports deny before any socket", async () => {
 for (const ip of ["127.0.0.1","10.0.0.1","169.254.169.254","100.64.0.1","::1","::ffff:127.0.0.1","fc00::1","2002:7f00:1::"]) expect(isPublicDownloadAddress(ip)).toBe(false);
 for (const url of ["http://example.com", "https://127.0.0.1", "https://[::1]", "https://user:pass@example.com", "https://example.com:8443"]) await expect(downloadPublicFile(url)).rejects.toThrow();
 expect(requests.length).toBe(0);
});
test("mixed DNS and redirects to metadata endpoints fail closed", async () => {
 answers.push({address:"127.0.0.1",family:4});
 await expect(downloadPublicFile("https://example.com")).rejects.toThrow();
 expect(requests.length).toBe(0);
 answers = [{address:"8.8.8.8",family:4}];
 replies = [{status:302,headers:{location:"https://169.254.169.254/latest/meta-data"}}];
 await expect(downloadPublicFile("https://example.com")).rejects.toThrow();
 expect(requests.length).toBe(1);
});
test("rejects advertised and streamed oversize bodies, non-2xx and redirect loops", async () => {
 replies=[{status:200,headers:{"content-length":String(MAX_FILE_BYTES+1)}}];
 await expect(downloadPublicFile("https://example.com")).rejects.toThrow();
 replies=[{status:200,chunks:Array.from({length:51},()=>Buffer.alloc(1024*1024))}];
 await expect(downloadPublicFile("https://example.com")).rejects.toThrow();
 replies=[{status:404}]; await expect(downloadPublicFile("https://example.com")).rejects.toThrow();
 replies=Array.from({length:4},()=>({status:302,headers:{location:"/again"}}));
 await expect(downloadPublicFile("https://example.com")).rejects.toThrow();
});

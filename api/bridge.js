import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const config = {
  api: { bodyParser: false },
  supportsResponseStreaming: true,
  maxDuration: 60,
};

const REMOTE_ENDPOINT = (process.env.REMOTE_ENDPOINT || "").replace(/\/$/, "");

const OMIT_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
]);

export default async function bridge(req, res) {
  if (!REMOTE_ENDPOINT) {
    res.statusCode = 500;
    return res.end("Configuration error");
  }

  try {
    const targetPath = REMOTE_ENDPOINT + req.url;

    const proxyHeaders = {};
    let sourceIp = null;
    
    for (const key of Object.keys(req.headers)) {
      const lowerKey = key.toLowerCase();
      const val = req.headers[key];
      
      if (OMIT_HEADERS.has(lowerKey)) continue;
      if (lowerKey.startsWith("x-vercel-")) continue;
      if (lowerKey === "x-real-ip") { sourceIp = val; continue; }
      if (lowerKey === "x-forwarded-for") { 
        if (!sourceIp) sourceIp = val; 
        continue; 
      }
      
      proxyHeaders[lowerKey] = Array.isArray(val) 
        ? val.join(", ") 
        : val;
    }
    
    if (sourceIp) proxyHeaders["x-forwarded-for"] = sourceIp;

    const requestMethod = req.method;
    const hasBody = requestMethod !== "GET" && requestMethod !== "HEAD";

    const options = { 
      method: requestMethod, 
      headers: proxyHeaders, 
      redirect: "manual" 
    };
    
    if (hasBody) {
      options.body = Readable.toWeb(req);
      options.duplex = "half";
    }

    const remoteResponse = await fetch(targetPath, options);

    res.statusCode = remoteResponse.status;
    
    for (const [headerName, headerValue] of remoteResponse.headers) {
      if (headerName.toLowerCase() === "transfer-encoding") continue;
      try { 
        res.setHeader(headerName, headerValue); 
      } catch {}
    }

    if (remoteResponse.body) {
      await pipeline(Readable.fromWeb(remoteResponse.body), res);
    } else {
      res.end();
    }
  } catch (error) {
    console.error("bridge error:", error);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end("Remote service error");
    }
  }
}

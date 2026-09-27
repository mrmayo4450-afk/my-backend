import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { createServer } from "http";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    // A 10 MiB image expands to about 13.34 MiB when base64-encoded.
    // Keep enough room for that payload plus JSON metadata while limiting other JSON requests.
    limit: "15mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: "50mb" }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      log(`${req.method} ${path} ${res.statusCode} in ${duration}ms`);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const requestedStatus = Number(err.status ?? err.statusCode);
    const status =
      Number.isInteger(requestedStatus) && requestedStatus >= 400 && requestedStatus < 600
        ? requestedStatus
        : 500;

    if (res.headersSent) {
      return next(err);
    }

    if (status >= 500) {
      console.error("Request failed with status", status);
    }

    const isProduction = process.env.NODE_ENV === "production";
    const message =
      isProduction && status >= 500
        ? "Internal Server Error"
        : err.message || "Internal Server Error";

    return res.status(status).json({ message });
  });

  // Standalone backend mode: frontend runs on a separate server.
  // CORS is configured above. No static file serving needed.

  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();

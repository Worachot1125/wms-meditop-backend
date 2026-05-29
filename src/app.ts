import express from "express";
import { logger } from "./lib/logger";
import cors from "cors";
import path from "path";
import apiRouter from "./routes/index";
import { errorHandler } from "./middleware/errroHandler";
import { loginByQuery } from "./controllers/auth.controller";
import { asyncHandler } from "./utils/asyncHandler";

const app = express();

// cors
app.use(
  cors({
    origin: ["http://localhost:5173", ...(process.env.CORS_ORIGIN ? [process.env.CORS_ORIGIN] : []),"http://172.20.10.3:5173"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true,
    
  })
);

// Serve static files (images) - assets อยู่นอก src
const assetsPath = path.join(process.cwd(), "assets", "images");
app.use("/assets/images", express.static(assetsPath));

// request logger
app.use((req, res, next) => {
  const start = Date.now();

  res.on("finish", () => {
    const ms = Date.now() - start;
    const status = res.statusCode;

    if (status >= 400) {
      logger.error(`${req.method} ${req.originalUrl} → ${status} (${ms}ms)`);
    } else {
      logger.info(`${req.method} ${req.originalUrl} → ${status} (${ms}ms)`);
    }
  });

  next();
});

// Body parser
app.use(express.json());

// Special route for Odoo (backward compatibility)
app.get("/api/login", asyncHandler(loginByQuery));
app.post("/api/login", asyncHandler(loginByQuery));

// Routes
app.use("/api", apiRouter);

// Error handling
app.use(errorHandler);


export default app;

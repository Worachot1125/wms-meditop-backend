import { Router } from "express";
import {
  syncDepartments,
  getSyncHistory,
  getLastSync,
} from "../controllers/sync.controller";

const router = Router();

// Department sync routes
router.post("/departments", syncDepartments);
router.get("/departments/history", getSyncHistory);
router.get("/departments/last", getLastSync);

export default router;

import { Router } from "express";
import { 
  getOdooLogFiles, 
  getOdooLogContent,
  getOdooRequestLogs,
  getOdooRequestLogById,
} from "../controllers/logs.controller";

const router = Router();

// Odoo Logs (File-based)
router.get("/odoo", getOdooLogFiles);
router.get("/odoo/:filename", getOdooLogContent);

// Odoo Logs (Database)
router.get("/odoo/database", getOdooRequestLogs);
router.get("/odoo/database/:id", getOdooRequestLogById);

export default router;

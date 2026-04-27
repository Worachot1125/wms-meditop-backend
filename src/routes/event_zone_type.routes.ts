import { Router } from "express";
import { handleEventZoneType } from "../controllers/event_zone_type.controller";

const router = Router();

// POST /api/EventZoneType - รับ event zone_types จาก Odoo (รองรับ create, update, delete)
router.post("/EventZoneType", handleEventZoneType);

export default router;

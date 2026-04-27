import { Router } from "express";
import { handleEventBarcodes } from "../controllers/event_barcodes.controller";

const router = Router();

// POST /api/EventBarcodes - รับ event barcodes จาก Odoo (พหูพจน์)
router.post("/EventBarcodes", handleEventBarcodes);

// POST /api/EventBarcode - alias สำหรับ singular form
router.post("/EventBarcode", handleEventBarcodes);

export default router;

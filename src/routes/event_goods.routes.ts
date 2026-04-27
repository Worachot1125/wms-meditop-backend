import { Router } from "express";
import { handleEventGoods } from "../controllers/event_goods.controller";

const router = Router();

// POST /api/EventGoods - รับ event จาก Odoo (พหูพจน์)
router.post("/EventGoods", handleEventGoods);

// POST /api/EventGood - alias สำหรับ singular form
router.post("/EventGood", handleEventGoods);

// Note: Manual sync moved to /api/goods/sync (in goods.routes.ts)

export default router;

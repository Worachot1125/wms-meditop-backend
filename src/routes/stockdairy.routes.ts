import { Router } from "express";
import {
  getWmsStockDailyAll,
  getWmsStockDailyPaginated,
  getWmsStockDailyById,
  getTransactionReport,
  getTransactionReportPaginated,
} from "../controllers/wms_stock_daily.controller";

const router = Router();

router.get("/getAll", getWmsStockDailyAll);
router.get("/get", getWmsStockDailyPaginated);
router.get("/getAll/history", getTransactionReport)
router.get("/get/history", getTransactionReportPaginated)
router.get("/get/:id", getWmsStockDailyById);

export default router;
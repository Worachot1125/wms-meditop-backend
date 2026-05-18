import { Router } from "express";
import {
  createWmsDailySnapshotManual,
  getWmsStockDailyAll,
  getWmsStockDailyPaginated,
  getWmsStockDailyById,
  getTransactionReport,
  getTransactionReportPaginated,
} from "../controllers/wms_stock_daily.controller";

const router = Router();

router.post("/sync", createWmsDailySnapshotManual);
router.get("/getAll", getWmsStockDailyAll);
router.get("/get", getWmsStockDailyPaginated);
router.get("/getAll/history", getTransactionReport)
router.get("/get/history", getTransactionReportPaginated)
router.get("/get/:id", getWmsStockDailyById);

export default router;
import { Router } from "express";
import { auth, checkOverwritePermission } from "../middleware/auth";
import {
  createStock,
  getStocks,
  getStocksPaginated,
  getStockById,
  updateStock,
  deleteStock,
  startStockCount,
  syncStockFromOdoo,
  createWmsStockSnapshot,
  getStockBalance,
  compareStockBalance,
  getStockHistory,
  applyStockBalanceToStock,
  getBorStocksPaginated,
  getSerStocksPaginated
} from "../controllers/stock.controller";

const router = Router();

router.post("/create", createStock);
router.get("/getAll", getStocks);
router.get("/get", getStocksPaginated);
router.get("/get/bor", getBorStocksPaginated);
router.get("/get/ser", getSerStocksPaginated);
router.get("/get/:id", getStockById);
// เพิ่ม middleware เช็คสิทธิ์สำหรับ overwrite stock count
router.patch("/update/:id", auth, checkOverwritePermission, updateStock);
router.delete("/delete/:id", deleteStock);
router.post("/start-count", startStockCount);

// Stock Balance Snapshot APIs
router.post("/sync", syncStockFromOdoo);
router.post("/create-snapshot", createWmsStockSnapshot);
router.get("/balance", getStockBalance);
router.get("/compare", compareStockBalance);
router.get("/history", getStockHistory);
router.post("/apply-balance", applyStockBalanceToStock);
export default router;

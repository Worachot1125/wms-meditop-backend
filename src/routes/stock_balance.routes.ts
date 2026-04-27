import { Router } from "express";
import { auth, checkOverwritePermission } from "../middleware/auth";
import {
  getAllStockBalances,
  getStockBalancesPaginated,
  getStockBalanceById,
  updateStockBalance,
} from "../controllers/stock.controller";

const router = Router();

// GET routes
router.get("/getAll", getAllStockBalances);
router.get("/get", getStockBalancesPaginated);
router.get("/get/:id", getStockBalanceById);

// UPDATE route - ต้องมีสิทธิ์ overwrite
router.patch("/update/:id", auth, checkOverwritePermission, updateStockBalance);

export default router;

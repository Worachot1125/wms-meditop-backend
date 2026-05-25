import { Router } from "express";
import { auth, attachDepartmentAccess } from "../middleware/auth";
import {
  startBorrowStock,
  scanBorrowStockBarcode,
  updateBorrowStockItem,
  deleteBorrowStockItem,
  confirmBorrowStock,
  getBorrowStocks,
  getBorrowStocksPaginated,
  getBorrowStockById,
  updateBorrowStock,
  deleteBorrowStock,
  scanBorrowStockLocation,
  scanBorrowStockBarcodePreview,
  getAllBorStocks,
  getBorStocksPaginated,
  getBorrowStockDailyPaginated,
  getBorStockById,
  getBorrowStocksByLocationName,
  runBorrowStockDailySnapshot,
} from "../controllers/borrow_stock.controller";

const router = Router();

router.post("/sync", runBorrowStockDailySnapshot);
router.get("/getAll", getBorrowStocks);
router.get("/bor/get", getAllBorStocks);
router.get("/get", auth, attachDepartmentAccess, getBorrowStocksPaginated);
router.get("/daily", getBorrowStockDailyPaginated);
router.get("/bor/get", getBorStocksPaginated);
router.get(
  "/bor/get/location",
  auth,
  attachDepartmentAccess,
  getBorrowStocksByLocationName,
);
router.get("/get/:id", getBorrowStockById);
router.get("/bor/get/:id", getBorStockById);
router.patch("/update/:id", updateBorrowStock);
router.delete("/delete/:id", deleteBorrowStock);

router.post("/scan/location", auth, scanBorrowStockLocation);
router.post("/scan/pre", auth, scanBorrowStockBarcodePreview);
router.post("/start", auth, startBorrowStock);
router.post("/:id/scan-barcode", auth, scanBorrowStockBarcode);
router.patch("/:id/items/:itemId", updateBorrowStockItem);
router.delete("/:id/items/:itemId", deleteBorrowStockItem);
router.post("/:id/confirm", confirmBorrowStock);

export default router;

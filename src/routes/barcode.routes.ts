import { Router } from "express";
//import { auth } from "../middleware/auth";
import {
  manualSyncBarcodes,
  createBarcode,
  getBarcodes,
  getBarcodesPaginated,
  getBarcodeById,
  updateBarcode,
  deleteBarcode,
} from "../controllers/barcode.controller";

const router = Router();

router.post("/sync", manualSyncBarcodes);  // Manual sync from Odoo
router.post("/create", createBarcode);
router.get("/getAll", getBarcodes);
router.get("/get", getBarcodesPaginated);
router.get("/get/:id", getBarcodeById);
router.patch("/update/:id", updateBarcode);
router.delete("/delete/:id", deleteBarcode);
export default router;

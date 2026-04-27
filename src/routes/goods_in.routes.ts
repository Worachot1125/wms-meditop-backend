import { Router } from "express";
import {
  createGoodsIn,
  deleteGoodsIn,
  getGoodsInById,
  getGoodsIns,
  getGoodsInsPaginated,
  updateGoodsIn,
} from "../controllers/goods_in.controller";
import {
  createBarcodeForGoodsIn,
  updateBarcodeForGoodsIn,
  deleteBarcodeForGoodsIn,
} from "../controllers/barcode.goods_in.controller";

const router = Router();

router.post("/create", createGoodsIn);
router.get("/getAll", getGoodsIns);
router.get("/get", getGoodsInsPaginated);
router.get("/get/:id", getGoodsInById);
router.patch("/update/:id", updateGoodsIn);
router.delete("/delete/:id", deleteGoodsIn);

// Barcode routes for goods_in
router.post("/barcode/create", createBarcodeForGoodsIn);
router.patch("/barcode/update/:goods_in_id", updateBarcodeForGoodsIn);
router.delete("/barcode/delete/:goods_in_id", deleteBarcodeForGoodsIn);

export default router;
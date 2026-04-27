import { Router } from "express";
//import { auth } from "../middleware/auth";
import {
  createGoods,
  getGoods,
  getGoodsPaginated,
  getGoodsById,
  updateGoods,
  deleteGoods,
  getWmsMdtGoods,
  getWmsMdtGoodsPaginated,
  getWmsMdtGoodsById,
  updateWmsMdtGoods,
  getAllProduct,
} from "../controllers/goods.controller";
import { manualSyncGoods } from "../controllers/event_goods.controller";

const router = Router();

router.post("/sync", manualSyncGoods);  // Manual sync from Odoo
router.post("/create", createGoods);
router.get("/getAll", getGoods);
router.get("/get", getGoodsPaginated);
router.get("/get/:id", getGoodsById);
router.patch("/update/:id", updateGoods);
router.delete("/delete/:id", deleteGoods);
// WMS MDT Goods routes
router.get("/wms_mdt_goods/getAll", getWmsMdtGoods);
router.get("/wms_mdt_goods/getAllProducts", getAllProduct);
router.get("/wms_mdt_goods/get", getWmsMdtGoodsPaginated);
router.patch("/wms_mdt_goods/update/:id", updateWmsMdtGoods);
router.get("/wms_mdt_goods/get/:id", getWmsMdtGoodsById);

export default router;

import { Router } from "express";
import {
  getWmsMdtGoods,
  getWmsMdtGoodsPaginated,
  getWmsMdtGoodsById,
  getAllProduct,
  updateWmsMdtGoods,
} from "../controllers/goods.controller";
import { manualSyncGoods } from "../controllers/event_goods.controller";

const router = Router();

router.post("/sync", manualSyncGoods);
router.get("/wms-mdt-goods/getAll", getWmsMdtGoods);
router.get("/wms-mdt-goods/getAllProducts", getAllProduct);
router.get("/wms-mdt-goods/get", getWmsMdtGoodsPaginated);
router.patch("/wms-mdt-goods/update/:id", updateWmsMdtGoods);
router.get("/wms-mdt-goods/get/:id", getWmsMdtGoodsById);

export default router;
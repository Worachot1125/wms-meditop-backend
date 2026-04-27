import { Router } from "express";
//import { auth } from "../middleware/auth";
import {
  createGoodsOut,
  getGoodsOut,
  getGoodsOutPaginated,
  getGoodsOutById,
  updateGoodsOut,
  deleteGoodsOut,
} from "../controllers/goods_out.controller";

const router = Router();

router.post("/create", createGoodsOut);
router.get("/getAll", getGoodsOut);
router.get("/get", getGoodsOutPaginated);
router.get("/get/:id", getGoodsOutById);
router.patch("/update/:id", updateGoodsOut);
router.delete("/delete/:id", deleteGoodsOut);

export default router;

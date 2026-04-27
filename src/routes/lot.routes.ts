import { Router } from "express";
//import { auth } from "../middleware/auth";
import {
  createLot,
  getLots,
  getLotsPaginated,
  getLotById,
  updateLot,
  deleteLot,
} from "../controllers/lot.controller";

const router = Router();

router.post("/create", createLot);
router.get("/getAll", getLots);
router.get("/get", getLotsPaginated);
router.get("/get/:no", getLotById);
router.patch("/update/:no", updateLot);
router.delete("/delete/:no", deleteLot);

export default router;

import { Router } from "express";
//import { auth } from "../middleware/auth";
import {
  createBox,
  getBoxes,
  getBoxesPaginated,
  getBoxById,
  getBoxByCode,
  updateBox,
  deleteBox,
} from "../controllers/box.controller";

const router = Router();

router.post("/create", createBox);
router.get("/getAll", getBoxes);
router.get("/get", getBoxesPaginated);
router.get("/get/:code", getBoxByCode);
router.get("/get/:id", getBoxById);
router.patch("/update/:id", updateBox);
router.delete("/delete/:id", deleteBox);

export default router;

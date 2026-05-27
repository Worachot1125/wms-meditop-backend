import { Router } from "express";
import {
  createTransportBKK,
  deleteTransportBKK,
  getTransportBKKById,
  getTransportsBKK,
  getTransportsBKKPaginated,
  updateTransportBKK,
} from "../controllers/transports_bkk.controller";

const router = Router();

router.post("/create", createTransportBKK);
router.get("/getAll", getTransportsBKK);
router.get("/get", getTransportsBKKPaginated);
router.get("/get/:id", getTransportBKKById);
router.patch("/update/:id", updateTransportBKK);
router.delete("/delete/:id", deleteTransportBKK);

export default router;
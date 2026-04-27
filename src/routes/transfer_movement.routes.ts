// /routes/transfer_movement.routes.ts
import { Router } from "express";
import { auth, denyOperatorCreateTransferMovement, attachDepartmentAccess } from "../middleware/auth";
import {
  createTransferMovement,
  getTransferMovements,
  getTransferMovementsPaginated,
  getTransferMovementByNo,
  updateTransferMovement,
  deleteTransferMovement,
  scanTransferMovementLocation,
  scanTransferMovementBarcode,
  confirmTransferMovementPick,
  confirmTransferMovementPut,
  scanTransferMovementNcrLocation ,
  getTransferMovementById,
  scanTransferMovementPutLocation,
} from "../controllers/transfer_movement.controller";

const router = Router();

router.post("/create", auth, denyOperatorCreateTransferMovement, createTransferMovement);
router.get("/getAll", auth, getTransferMovements);
router.get("/get", auth, attachDepartmentAccess, getTransferMovementsPaginated);
router.get("/get/:no", getTransferMovementByNo);
router.get("/get/:id",   getTransferMovementById,);
router.patch("/update/:id", updateTransferMovement);
router.delete("/delete/:no", deleteTransferMovement);

// scan
router.post("/:no/scan/location", scanTransferMovementLocation);
router.post("/:no/scan/location/put", scanTransferMovementPutLocation);
router.post("/:no/scan/location/ncr", scanTransferMovementNcrLocation );
router.post("/:no/scan/barcode", scanTransferMovementBarcode);
router.post("/:no/scan/confirm", confirmTransferMovementPick);
router.post("/:no/scan/confirm/put", confirmTransferMovementPut);

export default router;
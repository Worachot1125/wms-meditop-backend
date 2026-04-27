import { Router } from "express";
//import { auth } from "../middleware/auth";
import {
  createBarcodeCountDepartment,
  getBarcodeCountDepartments,
  getBarcodeCountDepartmentsPaginated,
  getBarcodeCountDepartmentById,
  updateBarcodeCountDepartment,
} from "../controllers/barcode_count_department.controller";

const router = Router();

router.post("/create", createBarcodeCountDepartment);
router.get("/getAll", getBarcodeCountDepartments);
router.get("/get", getBarcodeCountDepartmentsPaginated);
router.get("/get/:id", getBarcodeCountDepartmentById);
router.patch("/update/:id", updateBarcodeCountDepartment);

export default router;

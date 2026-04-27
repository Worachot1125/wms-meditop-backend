import { Router } from "express";
//import { auth } from "../middleware/auth";
import {
  manualSyncDepartments,
  createDepartment,
  getDepartments,
  getDepartmentsPaginated,
  getDepartmentById,
  updateDepartment,
  deleteDepartment,
} from "../controllers/department.controller";

const router = Router();

router.post("/sync", manualSyncDepartments);  // Manual sync from Odoo
router.post("/create", createDepartment);
router.get("/getAll", getDepartments);
router.get("/get", getDepartmentsPaginated);
router.get("/get/:id", getDepartmentById);
router.patch("/update/:id", updateDepartment);
router.delete("/delete/:id", deleteDepartment);

export default router;

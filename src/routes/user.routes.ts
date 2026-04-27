import { Router } from "express";
import { uploadUserFile } from "../middleware/upload";
import { auth, allowAdminOnly } from "../middleware/auth";
import {
  createUser,
  getUsers,
  getUsersPaginated,
  getUserById,
  updateUser,
  updateUserPin,
  deleteUser,
} from "../controllers/user.controller";

const router = Router();

router.post("/create",auth, allowAdminOnly, uploadUserFile, createUser);
router.get("/getAll", getUsers);
router.get("/get", getUsersPaginated);
router.get("/get/:id", getUserById);
router.patch("/update/:id", auth, allowAdminOnly, uploadUserFile, updateUser);
router.patch("/update/pin/:id", updateUserPin);
router.delete("/delete/:id", auth, allowAdminOnly, deleteUser);

export default router;

import { Router } from "express";
import {
  login,
  loginByQuery,
  logout,
  verifyUserForForgotPassword,
  updatePasswordByForgotFlow,
} from "../controllers/auth.controller";
import { auth } from "../middleware/auth";

const router = Router();

router.post("/login", login);
router.get("/login", loginByQuery); // For Odoo webhook (GET with query params)
router.post("/login-query", loginByQuery); // For Odoo webhook (POST with query params)
router.post("/logout", auth, logout);
router.post("/forgot-password/verify-user", verifyUserForForgotPassword);
router.post("/forgot-password/update-password", updatePasswordByForgotFlow);

export default router;

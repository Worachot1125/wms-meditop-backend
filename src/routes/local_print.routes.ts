import { Router } from "express";
import { printTsplLabel } from "../services/local_print.service";

const router = Router();

router.post("/print", async (req, res) => {
  try {
    await printTsplLabel(req.body);

    return res.json({
      success: true,
    });
  } catch (err: any) {
    console.error(err);

    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

export default router;
import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { departmentSyncService } from "../services/department.sync.service";

/**
 * Manual sync departments from Odoo
 * POST /api/sync/departments
 */
export const syncDepartments = asyncHandler(
  async (req: Request, res: Response) => {
    // TODO: Get user_id from auth middleware when implemented
    const triggeredBy = req.body.triggered_by || "manual";

    const result = await departmentSyncService.syncDepartments(triggeredBy);

    return res.status(result.success ? 200 : 207).json({
      success: result.success,
      message: result.success
        ? "Department sync completed successfully"
        : "Department sync completed with errors",
      data: {
        recordsFetched: result.recordsFetched,
        recordsCreated: result.recordsCreated,
        recordsUpdated: result.recordsUpdated,
        recordsDisabled: result.recordsDisabled,
        errors: result.errors,
      },
    });
  }
);

/**
 * Get sync history
 * GET /api/sync/departments/history
 */
export const getSyncHistory = asyncHandler(
  async (req: Request, res: Response) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
    const history = await departmentSyncService.getSyncHistory(limit);

    return res.json({
      total: history.length,
      data: history,
    });
  }
);

/**
 * Get last sync info
 * GET /api/sync/departments/last
 */
export const getLastSync = asyncHandler(
  async (req: Request, res: Response) => {
    const lastSync = await departmentSyncService.getLastSync();

    if (!lastSync) {
      return res.json({
        message: "No sync history found",
        data: null,
      });
    }

    return res.json({
      data: lastSync,
    });
  }
);

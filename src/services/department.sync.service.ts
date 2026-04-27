import { prisma } from "../lib/prisma";
import { odooDbService } from "./odoo.db.service";
import { logger } from "../lib/logger";

interface SyncResult {
  success: boolean;
  recordsFetched: number;
  recordsCreated: number;
  recordsUpdated: number;
  recordsDisabled: number;
  errors: string[];
}

export class DepartmentSyncService {
  /**
   * Main sync function for departments
   */
  async syncDepartments(triggeredBy: string = "system"): Promise<SyncResult> {
    const startTime = new Date();
    const result: SyncResult = {
      success: true,
      recordsFetched: 0,
      recordsCreated: 0,
      recordsUpdated: 0,
      recordsDisabled: 0,
      errors: [],
    };

    let logId: number | null = null;

    logger.info("🔄 Starting department sync from Odoo...", { triggeredBy });

    try {
      // Create sync log entry
      const syncLog = await prisma.odoo_sync_log.create({
        data: {
          entity_type: "department",
          sync_type: triggeredBy === "system" ? "scheduled" : "manual",
          status: "start",
          started_at: startTime,
          triggered_by: triggeredBy,
        },
      });
      logId = syncLog.id;
      logger.info(`📝 Created sync log ID: ${logId}`);

      // Step 1: Fetch departments from Odoo Database
      logger.info("📥 Fetching departments from Odoo database...");
      const odooDepartments = await odooDbService.getDepartments();
      result.recordsFetched = odooDepartments.length;
      logger.info(`✅ Fetched ${result.recordsFetched} departments from Odoo`);

      // Get all Odoo IDs from fetched data
      const odooIds = odooDepartments.map((dept) => dept.id);

      // Step 2: Process each Odoo department
      logger.info(`🔄 Processing ${odooDepartments.length} departments...`);
      for (const odooDept of odooDepartments) {
        try {
          // Check if department exists in WMS by odoo_id
          const existingDept = await prisma.department.findFirst({
            where: { odoo_id: odooDept.id },
          });

          const departmentData = {
            department_name: odooDept.name,
            department_code: odooDept.code,
            full_name: odooDept.name,
            short_name: odooDept.code,
            remark: `Synced from Odoo`,
            odoo_id: odooDept.id,
            is_active: true,
            last_synced_at: new Date(),
            updated_at: new Date(),
          };

          if (!existingDept) {
            // CREATE: Department doesn't exist in WMS
            const newDept = await prisma.department.create({
              data: departmentData,
            });
            result.recordsCreated++;
            logger.info(`➕ Created department: ${newDept.full_name} (ID: ${newDept.id}, Odoo ID: ${odooDept.id})`);
          } else {
            // Check if data is different
            const isDifferent =
              existingDept.department_name !== departmentData.department_name ||
              existingDept.department_code !== departmentData.department_code ||
              existingDept.full_name !== departmentData.full_name ||
              existingDept.short_name !== departmentData.short_name ||
              !existingDept.is_active;

            if (isDifferent) {
              // UPDATE: Data is different
              const { odoo_id, ...updateData } = departmentData;
              await prisma.department.update({
                where: { id: existingDept.id },
                data: updateData,
              });
              result.recordsUpdated++;
              logger.info(`🔄 Updated department: ${existingDept.full_name} → ${departmentData.full_name} (ID: ${existingDept.id})`);
            }
            // If data is the same, do nothing
          }
        } catch (error) {
          const errorMsg = `Error processing department ${odooDept.id}: ${error instanceof Error ? error.message : String(error)}`;
          result.errors.push(errorMsg);
          logger.error(`❌ ${errorMsg}`);
        }
      }

      // Step 3: Disable WMS departments that no longer exist in Odoo
      logger.info("🔍 Checking for departments to disable...");
      const wmsDepartmentsToDisable = await prisma.department.findMany({
        where: {
          odoo_id: { not: null, notIn: odooIds },
          is_active: true,
          deleted_at: null,
        },
      });

      if (wmsDepartmentsToDisable.length > 0) {
        logger.info(`⚠️ Found ${wmsDepartmentsToDisable.length} departments to disable`);
        for (const dept of wmsDepartmentsToDisable) {
          await prisma.department.update({
            where: { id: dept.id },
            data: {
              is_active: false,
              updated_at: new Date(),
            },
          });
          result.recordsDisabled++;
          logger.warn(`⛔ Disabled department: ${dept.full_name} (ID: ${dept.id}, Odoo ID: ${dept.odoo_id})`);
        }
      } else {
        logger.info("✅ No departments need to be disabled");
      }

      // Update sync log with success
      if (logId) {
        await prisma.odoo_sync_log.update({
          where: { id: logId },
          data: {
            status: "done",
            completed_at: new Date(),
            records_fetched: result.recordsFetched,
            records_created: result.recordsCreated,
            records_updated: result.recordsUpdated,
            records_disabled: result.recordsDisabled,
            error_message: result.errors.length > 0 ? result.errors.join("; ") : null,
          },
        });
      }

      const duration = new Date().getTime() - startTime.getTime();
      const status = result.errors.length === 0 ? "✅ SUCCESS" : "⚠️ PARTIAL SUCCESS";
      logger.info(`${status} Department sync completed in ${duration}ms`);
      logger.info(`📊 Summary: Fetched=${result.recordsFetched}, Created=${result.recordsCreated}, Updated=${result.recordsUpdated}, Disabled=${result.recordsDisabled}, Errors=${result.errors.length}`);

      result.success = result.errors.length === 0;
    } catch (error) {
      result.success = false;
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.errors.push(errorMessage);
      logger.error(`❌ FAILED Department sync error: ${errorMessage}`, error);

      // Update sync log with failure
      if (logId) {
        const stackTrace = error instanceof Error ? error.stack : undefined;
        await prisma.odoo_sync_log.update({
          where: { id: logId },
          data: {
            status: "error",
            completed_at: new Date(),
            records_fetched: result.recordsFetched,
            records_created: result.recordsCreated,
            records_updated: result.recordsUpdated,
            records_disabled: result.recordsDisabled,
            error_message: stackTrace ? `${errorMessage}\n\nStack trace:\n${stackTrace}` : errorMessage,
          },
        });
      }
    }

    return result;
  }

  /**
   * Get sync history
   */
  async getSyncHistory(limit: number = 50) {
    return await prisma.odoo_sync_log.findMany({
      where: { entity_type: "department" },
      orderBy: { started_at: "desc" },
      take: limit,
    });
  }

  /**
   * Get last sync info
   */
  async getLastSync() {
    return await prisma.odoo_sync_log.findFirst({
      where: { entity_type: "department" },
      orderBy: { started_at: "desc" },
    });
  }
}

export const departmentSyncService = new DepartmentSyncService();

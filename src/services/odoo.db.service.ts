import { Pool } from "pg";
import { logger } from "../lib/logger";

interface OdooDbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/**
 * Odoo Database Service
 * ใช้สำหรับ query จาก Odoo PostgreSQL database โดยตรง
 */
export class OdooDbService {
  private pool: Pool;

  constructor() {
    const config: OdooDbConfig = {
      host: process.env.ODOO_DB_HOST || "",
      port: parseInt(process.env.ODOO_DB_PORT || "5432"),
      database: process.env.ODOO_DB_NAME || process.env.ODOO_DB || "",
      user: process.env.ODOO_DB_USER || process.env.ODOO_USERNAME || "",
      password: process.env.ODOO_DB_PASSWORD || process.env.ODOO_PASSWORD || "",
    };

    if (!config.host || !config.database || !config.user || !config.password) {
      throw new Error("Missing Odoo database configuration. Please check environment variables.");
    }

    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    logger.info(`📊 Odoo DB Service initialized: ${config.host}:${config.port}/${config.database}`);
  }

  /**
   * Test database connection
   */
  async testConnection(): Promise<boolean> {
    try {
      const client = await this.pool.connect();
      await client.query("SELECT 1");
      client.release();
      logger.info("✅ Odoo DB connection successful");
      return true;
    } catch (error) {
      logger.error("❌ Odoo DB connection failed:", error);
      return false;
    }
  }

  /**
   * Query departments from wms.wms_mdt_department view
   */
  async getDepartments(): Promise<any[]> {
    try {
      logger.info("📥 Querying departments from Odoo database...");
      const query = `
        SELECT 
          department_id as id,
          department_name as name,
          department_code as code
        FROM wms.wms_mdt_department
        ORDER BY department_id
      `;

      const result = await this.pool.query(query);
      logger.info(`✅ Retrieved ${result.rows.length} departments from Odoo`);
      return result.rows;
    } catch (error) {
      logger.error("❌ Error fetching departments from Odoo DB:", error);
      throw new Error(
        `Failed to fetch departments from Odoo database: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Query goods/SKU from wms.wms_mdt_goods view
   */
  async getGoods(): Promise<any[]> {
    try {
      logger.info("📥 Querying goods from Odoo database...");
      const query = `
        SELECT 
          product_id,
          product_code,
          product_name,
          product_type,
          lot_id,
          lot_name,
          expiration_date,
          department_code,
          department_name,
          unit,
          zone_type,
          user_manaul_url,
          active,
          product_last_modified_date,
          lot_last_modified_date
        FROM wms.wms_mdt_goods
        ORDER BY product_id
      `;

      const result = await this.pool.query(query);
      logger.info(`✅ Retrieved ${result.rows.length} goods from Odoo`);
      return result.rows;
    } catch (error) {
      logger.error("❌ Error fetching goods from Odoo DB:", error);
      throw new Error(
        `Failed to fetch goods from Odoo database: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Query barcodes from wms.wms_mdt_barcode view
   */
  async getBarcodes(): Promise<any[]> {
    try {
      logger.info("📥 Querying barcodes from Odoo database...");
      const query = `
        SELECT 
          product_id,
          product_code,
          tracking,
          barcode,
          barcode_length,
          lot_start,
          lot_stop,
          exp_start,
          exp_stop,
          ratio,
          internal_use,
          active,
          barcode_last_modified_date
        FROM wms.wms_mdt_barcode
        ORDER BY product_id
      `;

      const result = await this.pool.query(query);
      logger.info(`✅ Retrieved ${result.rows.length} barcodes from Odoo`);
      return result.rows;
    } catch (error) {
      logger.error("❌ Error fetching barcodes from Odoo DB:", error);
      throw new Error(
        `Failed to fetch barcodes from Odoo database: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Query zone types from wms.wms_mdt_zone_types view
   */
  async getZoneTypes(): Promise<any[]> {
    try {
      logger.info("📥 Querying zone types from Odoo database...");
      const query = `
        SELECT 
          station_id,
          station_name,
          sequence,
          description,
          notes,
          temp_min,
          temp_max,
          humidity_min,
          humidity_max
        FROM wms.wms_mdt_zone_types
        ORDER BY station_id
      `;

      const result = await this.pool.query(query);
      logger.info(`✅ Retrieved ${result.rows.length} zone types from Odoo`);
      return result.rows;
    } catch (error) {
      logger.error("❌ Error fetching zone types from Odoo DB:", error);
      throw new Error(
        `Failed to fetch zone types from Odoo database: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Query stocks from wms.wms_mdt_stock view
   */
  async getStocks(): Promise<any[]> {
    try {
      logger.info("📥 Querying stocks from Odoo database...");
      const query = `
        SELECT 
          product_id,
          product_code,
          location_id,
          location_path,
          location_name,
          lot_id,
          lot_name,
          quantity,
          expiration_date,
          active
        FROM wms.wms_mdt_stock
        WHERE active = true
        ORDER BY product_id
      `;

      const result = await this.pool.query(query);
      logger.info(`✅ Retrieved ${result.rows.length} active stock records from Odoo`);
      return result.rows;
    } catch (error) {
      logger.error("❌ Error fetching stocks from Odoo DB:", error);
      throw new Error(
        `Failed to fetch stocks from Odoo database: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Close database pool
   */
  async close(): Promise<void> {
    logger.info("🔌 Closing Odoo database connection pool...");
    await this.pool.end();
    logger.info("✅ Odoo database connection pool closed");
  }
}

export const odooDbService = new OdooDbService();

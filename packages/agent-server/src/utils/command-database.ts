import { createPool, type Pool } from "mysql2/promise";

/** Opens the application database and fails fast when required migrations are missing. */
export async function connectCommandDatabase(mysqlUrl: string | undefined): Promise<Pool | undefined> {
  if (!mysqlUrl) return undefined;

  const pool = createPool({ uri: mysqlUrl, connectionLimit: 10 });
  try {
    await pool.query("SELECT 1 FROM commands LIMIT 1");
    await pool.query("SELECT 1 FROM outbox_events LIMIT 1");
    await pool.query("SELECT 1 FROM sessions LIMIT 1");
    return pool;
  } catch (error) {
    await pool.end();
    throw error;
  }
}

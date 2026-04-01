import { defineConfig } from "drizzle-kit";

const supabaseHost = process.env.SUPA_HOST;
const dbUrl = process.env.DATABASE_URL;

if (!supabaseHost && !dbUrl) {
  throw new Error("SUPABASE_DB_HOST or DATABASE_URL must be set");
}

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: supabaseHost
    ? {
        host: supabaseHost,
        user: process.env.SUPA_USER!,
        password: process.env.SUPA_PASS!,
        database: process.env.SUPA_DB || "postgres",
        port: parseInt(process.env.SUPA_PORT || "5432"),
        ssl: true,
      }
    : {
        url: dbUrl!,
      },
});

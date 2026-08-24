"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@ustal/database";
import { requireAdminSession } from "../../../lib/session";

export async function resolveReportAction(reportId: string, status: "resolved" | "dismissed") {
  requireAdminSession();
  const db = getDb();
  await db.update(schema.reports).set({ status }).where(eq(schema.reports.id, reportId));
  revalidatePath("/reports");
}

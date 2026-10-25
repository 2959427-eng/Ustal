"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb, schema } from "@ustal/database";
import { requireAdminPermission } from "../../../lib/session";
import { assertOneOf, REPORT_STATUS_VALUES } from "../../../lib/admin-access";

export async function resolveReportAction(reportId: string, status: "resolved" | "dismissed") {
  await requireAdminPermission("reports.resolve");
  status = assertOneOf(status, REPORT_STATUS_VALUES);
  const db = getDb();
  await db.update(schema.reports).set({ status }).where(eq(schema.reports.id, reportId));
  revalidatePath("/reports");
}

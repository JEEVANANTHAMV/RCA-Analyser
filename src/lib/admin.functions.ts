import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/lib/auth-middleware";
import { getDb } from "@/lib/database";
import { getAllUsers, getAnalytics, getAllCases, changeUserRole, deleteUser } from "@/lib/auth";

async function assertAdmin(user: any) {
  if (user?.role !== "admin") throw new Error("Forbidden — admin only");
}

export const adminListUsers = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { user } = context;
    await assertAdmin(user);
    const users = getAllUsers();
    return { users };
  });

export const adminListAllCases = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { user } = context;
    await assertAdmin(user);
    const cases = getAllCases();
    return { cases };
  });

export const adminAnalytics = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { user } = context;
    await assertAdmin(user);
    const stats = getAnalytics();
    return stats;
  });

export const adminDeleteCase = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) => z.object({ caseId: z.string() }).parse(input))
  .handler(async ({ data, context }) => {
    const { user } = context;
    await assertAdmin(user);
    const db = getDb();
    db.prepare("DELETE FROM rca_cases WHERE id = ?").run(data.caseId);
    return { ok: true };
  });

export const adminToggleRole = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) =>
    z
      .object({
        targetUserId: z.string(),
        makeAdmin: z.boolean(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { user } = context;
    await assertAdmin(user);
    if (data.targetUserId === user.id && !data.makeAdmin) {
      throw new Error("You cannot demote yourself");
    }
    await changeUserRole(data.targetUserId, data.makeAdmin ? "admin" : "user");
    return { ok: true };
  });

export const adminDeleteUser = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) => z.object({ targetUserId: z.string() }).parse(input))
  .handler(async ({ data, context }) => {
    const { user } = context;
    await assertAdmin(user);
    if (data.targetUserId === user.id) throw new Error("Cannot delete yourself");
    deleteUser(data.targetUserId);
    return { ok: true };
  });

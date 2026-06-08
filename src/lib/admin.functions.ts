import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "@/lib/auth-middleware";
import { getDb } from "@/lib/database";
import {
  getAllUsers,
  getAnalytics,
  getAllCases,
  changeUserRole,
  deleteUser,
  createInvite,
  getInvites,
  deleteInvite,
  adminResetPassword,
  AuthUser,
} from "@/lib/auth";
import { sendInvitationEmail } from "@/lib/mail";

async function assertAdmin(user: AuthUser | null | undefined) {
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

export const adminGenerateInvite = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) =>
    z
      .object({
        email: z.string().email(),
        role: z.enum(["admin", "user"]),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { user } = context;
    await assertAdmin(user);
    const invite = createInvite(data.email, data.role, user.id);
    await sendInvitationEmail({
      to: data.email,
      code: invite.code,
      role: data.role,
    });
    return invite;
  });

export const adminBulkGenerateInvites = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) =>
    z
      .object({
        textarea: z.string().min(1),
        role: z.enum(["admin", "user"]),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { user } = context;
    await assertAdmin(user);
    const entries = data.textarea.split(";").map((s) => s.trim()).filter(Boolean);
    const results: Array<{ email: string; code: string; ok: boolean }> = [];
    for (const entry of entries) {
      const parts = entry.trim().split(/\s+/);
      const rawEmail = parts.length >= 2 ? parts[parts.length - 1] : parts[0];
      const email = rawEmail.replace(/[;]$/, "").trim();
      try {
        z.string().email().parse(email);
      } catch {
        results.push({ email, code: "", ok: false });
        continue;
      }
      try {
        const invite = createInvite(email, data.role, user.id);
        await sendInvitationEmail({
          to: email,
          code: invite.code,
          role: data.role,
        });
        results.push({ email, code: invite.code, ok: true });
      } catch {
        results.push({ email, code: "", ok: false });
      }
    }
    return { results };
  });


export const adminListInvites = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { user } = context;
    await assertAdmin(user);
    const invites = getInvites();
    return { invites };
  });

export const adminDeleteInvite = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) => z.object({ code: z.string() }).parse(input))
  .handler(async ({ data, context }) => {
    const { user } = context;
    await assertAdmin(user);
    deleteInvite(data.code);
    return { ok: true };
  });

export const adminResetOperatorPassword = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) =>
    z
      .object({
        targetUserId: z.string(),
        newPassword: z.string().min(8),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { user } = context;
    await assertAdmin(user);
    await adminResetPassword(data.targetUserId, data.newPassword);
    return { ok: true };
  });

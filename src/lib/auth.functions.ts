import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  signin as doSignin,
  signup as doSignup,
  invalidateSession,
  signupWithInvite,
  verifyInviteCode,
  changePassword,
} from "@/lib/auth";
import { requireAuth } from "@/lib/auth-middleware";

export const signinFn = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        email: z.string().email(),
        password: z.string().min(1),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const result = await doSignin(data.email, data.password);
    return result;
  });

export const signupFn = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        email: z.string().email(),
        password: z.string().min(8),
        fullName: z.string().max(100),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const result = await doSignup(data.email, data.password, data.fullName);
    return result;
  });

export const signoutFn = createServerFn({ method: "POST" }).handler(async () => {
  const getRequest = (await import("@tanstack/react-start/server")).getRequest;
  const request = await getRequest();
  const cookie = request?.headers.get("cookie") || "";
  const token = (cookie.match(/auth_token=([^;]+)/) || [])[1];
  if (token) {
    invalidateSession(decodeURIComponent(token));
  }
  return { ok: true };
});

export const validateInviteCodeFn = createServerFn({ method: "GET" })
  .inputValidator((input) => z.object({ code: z.string() }).parse(input))
  .handler(async ({ data }) => {
    const invite = verifyInviteCode(data.code);
    return invite;
  });

export const signupWithInviteFn = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        code: z.string(),
        email: z.string().email(),
        password: z.string().min(8),
        fullName: z.string().max(100),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const result = await signupWithInvite(data.code, data.email, data.password, data.fullName);
    return result;
  });

export const changeOwnPasswordFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input) =>
    z
      .object({
        oldPassword: z.string(),
        newPassword: z.string().min(8),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    await changePassword(userId, data.oldPassword, data.newPassword);
    return { ok: true };
  });

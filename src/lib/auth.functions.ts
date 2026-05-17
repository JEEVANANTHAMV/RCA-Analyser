import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { signin as doSignin, signup as doSignup, invalidateSession } from "@/lib/auth";

export const signinFn = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({
      email: z.string().email(),
      password: z.string().min(1),
    }).parse(input),
  )
  .handler(async ({ data }) => {
    const result = await doSignin(data.email, data.password);
    return result;
  });

export const signupFn = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({
      email: z.string().email(),
      password: z.string().min(8),
      fullName: z.string().max(100),
    }).parse(input),
  )
  .handler(async ({ data }) => {
    const result = await doSignup(data.email, data.password, data.fullName);
    return result;
  });

export const signoutFn = createServerFn({ method: "POST" })
  .handler(async () => {
    const getRequest = (await import("@tanstack/react-start/server")).getRequest;
    const request = await getRequest();
    const cookie = request?.headers.get("cookie") || "";
    const token = (cookie.match(/auth_token=([^;]+)/) || [])[1];
    if (token) {
      invalidateSession(decodeURIComponent(token));
    }
    return { ok: true };
  });

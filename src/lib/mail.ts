import nodemailer from "nodemailer";

interface SendInviteParams {
  to: string;
  code: string;
  role: "admin" | "user";
}

export async function sendInvitationEmail({ to, code, role }: SendInviteParams): Promise<void> {
  const host = process.env.SMTP_HOST || "smtppro.zoho.in";
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const secure = process.env.SMTP_SECURE === "true";
  const user = process.env.SMTP_USER || "no-reply@innosynth.org";
  const pass = process.env.SMTP_PASSWORD;
  const senderEmail = process.env.SENDER_EMAIL || user;
  const baseUrl = process.env.BASE_URL || "http://localhost:5173";
  const allowUnauthorized = process.env.ALLOW_UNAUTHORIZED_CERTS === "true";

  if (!pass) {
    console.error("SMTP_PASSWORD is not configured in the environment.");
    throw new Error("SMTP server credentials are not fully configured.");
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user,
      pass,
    },
    tls: {
      rejectUnauthorized: !allowUnauthorized,
    },
  });

  const inviteUrl = `${baseUrl}/signup?code=${code}`;

  const roleText = role === "admin" ? "Administrator" : "Operator (User)";

  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>RCA Analyser Invitation</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background-color: #f6f8fa;
            color: #24292f;
            margin: 0;
            padding: 0;
          }
          .container {
            max-width: 600px;
            margin: 40px auto;
            background-color: #ffffff;
            border: 1px solid #d0d7de;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 4px 12px rgba(0,0,0,0.05);
          }
          .header {
            background-color: #f6f8fa;
            padding: 24px;
            border-bottom: 1px solid #d0d7de;
            text-align: center;
          }
          .header h1 {
            color: #0969da;
            margin: 0;
            font-size: 20px;
            letter-spacing: 0.5px;
            font-family: "Courier New", Courier, monospace;
          }
          .content {
            padding: 32px 24px;
            line-height: 1.6;
            color: #24292f;
          }
          .content p {
            margin: 0 0 16px;
            font-size: 15px;
            color: #24292f;
          }
          .role-badge {
            display: inline-block;
            background-color: #ddf4ff;
            color: #0969da;
            border: 1px solid #54aeff;
            padding: 4px 10px;
            border-radius: 4px;
            font-size: 12px;
            font-family: monospace;
            font-weight: bold;
            margin-bottom: 20px;
          }
          .btn-container {
            text-align: center;
            margin: 28px 0;
          }
          .btn {
            background-color: #2da44e;
            color: #ffffff !important;
            text-decoration: none;
            padding: 12px 24px;
            font-size: 15px;
            font-weight: bold;
            border-radius: 6px;
            display: inline-block;
            transition: background-color 0.2s;
            border: 1px solid rgba(27,31,35,0.15);
          }
          .btn:hover {
            background-color: #2c974b;
          }
          .invite-code {
            background-color: #f6f8fa;
            border: 1px dashed #d0d7de;
            padding: 12px;
            border-radius: 6px;
            text-align: center;
            font-family: monospace;
            font-size: 18px;
            letter-spacing: 2px;
            color: #0969da;
            margin: 20px 0;
            font-weight: bold;
          }
          .footer {
            background-color: #f6f8fa;
            padding: 20px;
            border-top: 1px solid #d0d7de;
            font-size: 12px;
            color: #57606a;
            text-align: center;
            font-family: monospace;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="color: #0969da; margin: 0; font-size: 20px; font-family: monospace;">// RCA.ANALYSER_CONSOLE</h1>
          </div>
          <div class="content" style="color: #24292f;">
            <p style="color: #24292f;">Hello,</p>
            <p style="color: #24292f;">You have been invited to join the RCA Analyser platform. Your account is ready to be set up with the following privilege role:</p>
            <div>
              <span class="role-badge" style="background-color: #ddf4ff; color: #0969da; border: 1px solid #54aeff;">${roleText.toUpperCase()}</span>
            </div>
            <p style="color: #24292f;">To configure your password and complete your registration, please click the button below:</p>
            <div class="btn-container">
              <a href="${inviteUrl}" target="_blank" class="btn" style="color: #ffffff;">Complete Registration</a>
            </div>
            <p style="color: #24292f;">Alternatively, you can copy and paste this link into your browser:</p>
            <p style="word-break: break-all; font-size: 13px; color: #57606a; font-family: monospace;">${inviteUrl}</p>
            <p style="color: #24292f;">Or use your invite code directly on the registration page:</p>
            <div class="invite-code" style="color: #0969da; background-color: #f6f8fa; border: 1px dashed #d0d7de;">${code}</div>
            <p style="font-size: 13px; color: #57606a;">Note: This invitation is linked to your email address and will expire in 7 days.</p>
          </div>
          <div class="footer" style="color: #57606a;">
            SYSTEM GENERATED EMAIL. DO NOT REPLY.
          </div>
        </div>
      </body>
    </html>
  `;

  await transporter.sendMail({
    from: `"RCA Analyser Console" <${senderEmail}>`,
    to,
    subject: "RCA Analyser — Registration Invite",
    text: `You have been invited to join the RCA Analyser console as an ${roleText}.\n\nComplete your registration here:\n${inviteUrl}\n\nInvite Code: ${code}`,
    html: htmlContent,
  });
}

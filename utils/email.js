// utils/email.js
import { EmailClient } from "@azure/communication-email";

let client = null;
let fromAddress = null;

export function initEmail() {
  const conn = process.env.ACS_CONNECTION_STRING;
  fromAddress = process.env.EMAIL_FROM;

  if (!conn || !fromAddress) {
    console.warn(
      "⚠️  Email disabled: missing ACS_CONNECTION_STRING or EMAIL_FROM in .env"
    );
    client = null;
    return;
  }

  client = new EmailClient(conn);
  console.log("📧 Email client initialized");
}

export async function sendEmail({ to, subject, html, text }) {
  if (!client) throw new Error("Email client not configured");
  if (!fromAddress) throw new Error("EMAIL_FROM is not configured");

  // Normalize & validate inputs to avoid ".replace of undefined" type errors
  const toList = Array.isArray(to) ? to : [to];
  const cleanTo = toList
    .map(v => (v ?? "").toString().trim())
    .filter(v => v.length > 0);

  const cleanSubject = (subject ?? "").toString();
  const bodyHtml = (html ?? text ?? "").toString();

  if (cleanTo.length === 0) throw new Error("Missing 'to' email address");
  if (!cleanSubject) throw new Error("Missing email subject");
  if (!bodyHtml) throw new Error("Missing email body");

  const message = {
    senderAddress: fromAddress, // e.g. DoNotReply@<your-managed-domain>.azurecomm.net
    recipients: { to: cleanTo.map(a => ({ address: a })) },
    content: { subject: cleanSubject, html: bodyHtml }
  };

  // helpful debug line (safe to keep during setup)
  // console.log("Email payload:", JSON.stringify(message, null, 2));

  const poller = await client.beginSend(message);
  const result = await poller.pollUntilDone();
  return result;
}

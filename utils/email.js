// utils/email.js
import { EmailClient } from "@azure/communication-email";

let emailClient = null;
let fromAddress = null;

function ensureClient() {
  if (!emailClient) {
    const conn = process.env.ACS_CONNECTION_STRING;
    const from = process.env.EMAIL_FROM;
    fromAddress = from;
    if (conn && from) {
      emailClient = new EmailClient(conn);
      console.log("📧 Email client initialized");
    } else {
      console.warn("⚠️ Email client not configured. Set ACS_CONNECTION_STRING and EMAIL_FROM.");
    }
  }
  return { emailClient, fromAddress };
}

export async function sendEmail(to, subject, html) {
  const { emailClient, fromAddress } = ensureClient();
  if (!emailClient || !fromAddress) {
    console.warn("⚠️ sendEmail skipped — missing config");
    return;
  }

  const message = {
    senderAddress: fromAddress,
    content: {
      subject,
      html,
      plainText: html.replace(/<[^>]+>/g, " ")
    },
    recipients: { to: [{ address: to }] }
  };

  try {
    const poller = await emailClient.beginSend(message);
    const result = await poller.pollUntilDone();
    if (result.status === "Succeeded") {
      console.log(`✅ Email sent to ${to}`);
    } else {
      console.error(`❌ Email send status: ${result.status}`);
    }
  } catch (err) {
    console.error("❌ Email send error:", err);
  }
}

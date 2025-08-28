const { EmailClient } = require("@azure/communication-email");

async function sendEmail(to, subject, html) {
  const client = new EmailClient(process.env.ACS_CONNECTION_STRING);

  const message = {
    senderAddress: process.env.EMAIL_FROM,
    content: {
      subject,
      html,
    },
    recipients: { to: [{ address: to }] },
  };

  try {
    const poller = await client.beginSend(message);
    const result = await poller.pollUntilDone();
    console.log("📧 Email sent:", result);
  } catch (err) {
    console.error("❌ Email send error:", err.message);
  }
}

module.exports = { sendEmail };

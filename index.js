// index.js
import "dotenv/config";
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./swagger.js";
import express from "express";
import sql from "mssql";
import multer from "multer";
import { BlobServiceClient } from "@azure/storage-blob";
import cron from "node-cron";
import cors from "cors";

import authRoutes from "./routes/auth.js";
import doctorRoutes from "./routes/doctors.js";
import patientRoutes from "./routes/patients.js";
import appointmentRoutes from "./routes/appointments.js";
import recordsRoutes from "./routes/records.js";
import { initEmail } from "./utils/email.js";
initEmail();


import { authenticate } from "./middleware/auth.js"; 

const app = express();

// ✅ Middlewares
app.use(cors());
app.use(express.json()); // 👈 MUST be before routes

// ✅ Mount routes
app.use("/api/auth", authRoutes);
app.use("/api/doctor", doctorRoutes);
app.use("/api/patient", patientRoutes);
app.use("/api/appointments", appointmentRoutes);
app.use("/api/records", recordsRoutes);

app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  swaggerOptions: { persistAuthorization: true }
}));
app.get("/openapi.json", (_req, res) => res.json(swaggerSpec));

// DB config
const config = {
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  server: process.env.SQL_SERVER,
  database: process.env.SQL_DB,
  options: {
    encrypt: true,
    trustServerCertificate: false
  }
};

// Connect once at startup
try {
  await sql.connect(config);
  console.log("✅ Connected to Azure SQL Database");
} catch (err) {
  console.error("❌ DB Connection Error:", err.message);
}

// Azure Blob
const blobServiceClient = BlobServiceClient.fromConnectionString(
  process.env.AZURE_STORAGE_CONNECTION_STRING
);
const containerClient = blobServiceClient.getContainerClient("medical-files");

// Multer
const upload = multer({ storage: multer.memoryStorage() });

// ✅ File Upload
app.post("/api/records/upload", upload.single("file"), async (req, res) => {
  try {
    const blobName = Date.now() + "-" + req.file.originalname;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.uploadData(req.file.buffer);

    await sql.query`
      INSERT INTO MedicalRecords (patient_id, file_path, uploaded_at, blob_container)
      VALUES (${req.body.patientId}, ${blockBlobClient.url}, GETUTCDATE(), ${containerClient.containerName})
    `;

    res.json({ message: "File uploaded", url: blockBlobClient.url });
  } catch (err) {
    console.error("❌ Upload Error:", err.message);
    res.status(500).json({ error: "Failed to upload record" });
  }
});

// ⏰ Notification Job
// ⏰ Daily reminder job — runs at 09:00 server time
cron.schedule("0 9 * * *", async () => {
  try {
    // Appointments scheduled for "tomorrow" (UTC compare)
    const res = await sql.query`
      SELECT a.appointment_id, a.appointment_date,
             pu.email       AS patient_email,
             pu.full_name   AS patient_name,
             du.full_name   AS doctor_name
      FROM Appointments a
      JOIN Patients p  ON a.patient_id = p.patient_id
      JOIN Users pu    ON p.user_id    = pu.user_id
      JOIN Doctors d   ON a.doctor_id  = d.doctor_id
      JOIN Users du    ON d.user_id    = du.user_id
      WHERE CAST(a.appointment_date AS DATE) = CAST(DATEADD(day, 1, GETUTCDATE()) AS DATE)
        AND a.status = 'Scheduled'
        AND NOT EXISTS (
          SELECT 1 FROM Notifications n
          WHERE n.appointment_id = a.appointment_id
            AND n.status = 'Sent'
            AND n.sent_at >= DATEADD(day, -2, a.appointment_date) -- don't resend reminders
        )
    `;

    for (const appt of res.recordset) {
      let sentOK = false;
      try {
        await sendEmail({
          to: appt.patient_email,
          subject: `Reminder: Appointment tomorrow with ${appt.doctor_name}`,
          html: `
            <p>Hi ${appt.patient_name},</p>
            <p>This is a reminder for your appointment with <b>${appt.doctor_name}</b> on 
            <b>${new Date(appt.appointment_date).toLocaleString('en-IN',{ timeZone: 'Asia/Kolkata' })}</b>.</p>
            <p>See you soon.</p>
          `,
        });
        sentOK = true;
      } catch (e) {
        console.warn("Reminder email send failed:", e?.message || e);
      }

      if (sentOK) {
        await sql.query`
          INSERT INTO Notifications (appointment_id, sent_at, status)
          VALUES (${appt.appointment_id}, GETUTCDATE(), 'Sent')
        `;
      } else {
        await sql.query`
          INSERT INTO Notifications (appointment_id, sent_at, status)
          VALUES (${appt.appointment_id}, NULL, 'Failed')
        `;
      }
    }
  } catch (e) {
    console.error("Reminder cron error:", e?.message || e);
  }
});


// Start server
app.listen(3000, () => console.log("🚀 Backend running on http://localhost:3000"));

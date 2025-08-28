// index.js
import "dotenv/config";

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
import { sendEmail } from "./utils/email.js";

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
  console.log("🔔 Running daily reminder job...");

  try {
    // Find tomorrow's appointments that are still 'Scheduled' and not already reminded
    const result = await sql.query`
      SELECT 
        a.appointment_id,
        a.appointment_date,
        pu.email         AS patient_email,
        pu.full_name     AS patient_name,
        du.full_name     AS doctor_name
      FROM Appointments a
      JOIN Patients p ON a.patient_id = p.patient_id
      JOIN Users pu   ON p.user_id    = pu.user_id
      JOIN Doctors d  ON a.doctor_id  = d.doctor_id
      JOIN Users du   ON d.user_id    = du.user_id
      LEFT JOIN Notifications n 
        ON n.appointment_id = a.appointment_id
       AND n.notification_type = 'reminder'
      WHERE a.status = 'Scheduled'
        AND CAST(a.appointment_date AS DATE) = CAST(DATEADD(day, 1, GETDATE()) AS DATE)
        AND n.appointment_id IS NULL
    `;

    for (const row of result.recordset) {
      try {
        // Format in IST (adjust if your clinic timezone is different)
        const whenIST = new Intl.DateTimeFormat("en-IN", {
          timeZone: "Asia/Kolkata",
          year: "numeric", month: "long", day: "numeric",
          hour: "numeric", minute: "2-digit"
        }).format(new Date(row.appointment_date));

        await sendEmail(
          row.patient_email,
          "Appointment Reminder",
          `<p>Hi ${row.patient_name || "there"},</p>
           <p>This is a reminder about your appointment with 
           <b>${row.doctor_name || "your doctor"}</b> tomorrow at <b>${whenIST} (IST)</b>.</p>
           <p>— Smart Health Portal</p>`
        );

        // Mark as reminded so we don't send again
        await sql.query`
          INSERT INTO Notifications (appointment_id, notification_type, sent_at)
          VALUES (${row.appointment_id}, 'reminder', SYSUTCDATETIME())
        `;

        console.log(`✅ Reminder sent for appointment ${row.appointment_id}`);
      } catch (e) {
        console.error(`⚠️  Failed to send reminder for appt ${row.appointment_id}:`, e.message);
      }
    }
  } catch (err) {
    console.error("❌ Reminder job error:", err);
  }
});


// Start server
app.listen(3000, () => console.log("🚀 Backend running on http://localhost:3000"));

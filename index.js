// index.js
import dotenv from "dotenv";
dotenv.config();

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
cron.schedule("0 9 * * *", async () => {
  try {
    const result = await sql.query`
      SELECT * FROM Appointments 
      WHERE CAST(appointment_date AS DATE) = CAST(GETDATE() AS DATE)
    `;
    result.recordset.forEach(appt => {
      console.log(`📢 Reminder: Patient ${appt.patient_id} has appointment at ${appt.appointment_date}`);
    });
  } catch (err) {
    console.error("❌ Cron Error:", err.message);
  }
});

// Start server
app.listen(3000, () => console.log("🚀 Backend running on http://localhost:3000"));

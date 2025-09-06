// index.js
import "dotenv/config";

import express from "express";
import cors from "cors";
import sql from "mssql";
import cron from "node-cron";

import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./swagger.js";

import authRoutes from "./routes/auth.js";
import doctorRoutes from "./routes/doctors.js";
import patientRoutes from "./routes/patients.js";
import appointmentRoutes from "./routes/appointments.js";
import recordsRoutes from "./routes/records.js";

import { initEmail, sendEmail } from "./utils/email.js"; // init + sender

/* -------------------- App & middleware -------------------- */
const app = express();
app.use(
  cors({
    origin: "https://healthcareblobstorage.z29.web.core.windows.net",
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  })
);

app.use(express.json()); // must be before routes

/* -------------------- DB connection -------------------- */
const dbConfig = {
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  server: process.env.SQL_SERVER,
  database: process.env.SQL_DB,
  options: {
    encrypt: true,
    trustServerCertificate: false,
  },
};

try {
  await sql.connect(dbConfig);
  console.log("✅ Connected to Azure SQL Database");
} catch (err) {
  console.error("❌ DB Connection Error:", err.message);
}

/* -------------------- Email init -------------------- */
initEmail(); // logs status; safe if missing env (will warn)

/* -------------------- Routes -------------------- */
app.use("/api/auth", authRoutes);
app.use("/api/doctor", doctorRoutes);
app.use("/api/patient", patientRoutes);
app.use("/api/appointments", appointmentRoutes);
app.use("/api/records", recordsRoutes);

// Swagger
app.use(
  "/api-docs",
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec, {
    swaggerOptions: { persistAuthorization: true },
  })
);
app.get("/openapi.json", (_req, res) => res.json(swaggerSpec));

// Optional health check
app.get("/", (_req, res) => res.send("Smart Health backend is running."));

/* -------------------- Daily reminder cron -------------------- */
/**
 * Runs every day at 09:00 IST. It finds appointments scheduled for "tomorrow"
 * (based on UTC date compare for simplicity) that are still 'Scheduled' and
 * for which no 'Sent' notification exists in the last 2 days.
 */
cron.schedule(
  "0 9 * * *",
  async () => {
    try {
      const res = await sql.query`
        SELECT 
          a.appointment_id,
          a.appointment_date,
          pu.email     AS patient_email,
          pu.full_name AS patient_name,
          du.full_name AS doctor_name
        FROM Appointments a
        JOIN Patients p ON a.patient_id = p.patient_id
        JOIN Users pu   ON p.user_id    = pu.user_id
        JOIN Doctors d  ON a.doctor_id  = d.doctor_id
        JOIN Users du   ON d.user_id    = du.user_id
        WHERE CAST(a.appointment_date AS DATE) = CAST(DATEADD(day, 1, GETUTCDATE()) AS DATE)
          AND a.status = 'Scheduled'
          AND NOT EXISTS (
            SELECT 1
            FROM Notifications n
            WHERE n.appointment_id = a.appointment_id
              AND n.status = 'Sent'
              AND n.sent_at >= DATEADD(day, -2, a.appointment_date)
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
              <p>This is a reminder for your appointment with <b>${
                appt.doctor_name
              }</b> on 
              <b>${new Date(appt.appointment_date).toLocaleString("en-IN", {
                timeZone: "Asia/Kolkata",
              })}</b>.</p>
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
  },
  { timezone: "Asia/Kolkata" } // 👈 run at 9AM IST
);

/* -------------------- Start server -------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend running on port ${PORT}`));

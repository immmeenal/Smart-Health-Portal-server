// routes/patients.js
import express from "express";
import sql from "mssql";
import { authenticate, authorizeRole } from "../middleware/auth.js";

const router = express.Router();

/**
 * Patient only: my profile
 * GET /api/patient/me
 */
router.get("/me", authenticate, authorizeRole("Patient"), async (req, res) => {
  try {
    const userId = req.user.user_id;
    const result = await sql.query`
      SELECT
        u.user_id, u.full_name, u.email, u.phone_number,
        p.patient_id, p.date_of_birth, p.gender, p.address, p.emergency_contact
      FROM Users u
      LEFT JOIN Patients p ON p.user_id = u.user_id
      WHERE u.user_id = ${userId}
    `;
    if (!result.recordset.length) {
      return res.status(404).json({ error: "Profile not found" });
    }
    res.json(result.recordset[0]);
  } catch (err) {
    console.error("❌ Patient me error:", err.message);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

/**
 * Patient only: my appointments
 * GET /api/patient/appointments
 *
 * IMPORTANT: patient_id != user_id
 * Resolve patient_id from JWT user_id first, then query Appointments.
 */
router.get(
  "/appointments",
  authenticate,
  authorizeRole("Patient"),
  async (req, res) => {
    try {
      const userId = req.user.user_id;

      const p = await sql.query`
        SELECT patient_id FROM Patients WHERE user_id = ${userId}
      `;
      if (!p.recordset.length) {
        return res.status(404).json({ error: "Patient record not found" });
      }
      const patient_id = p.recordset[0].patient_id;

      const appts = await sql.query`
        SELECT appointment_id, appointment_date, status, doctor_id
        FROM Appointments
        WHERE patient_id = ${patient_id}
        ORDER BY appointment_date DESC
      `;
      res.json(appts.recordset);
    } catch (err) {
      console.error("❌ Patient appointments error:", err.message);
      res.status(500).json({ error: "Failed to fetch appointments" });
    }
  }
);

/**
 * Patient only: my records
 * GET /api/patient/records
 */
router.get(
  "/records",
  authenticate,
  authorizeRole("Patient"),
  async (req, res) => {
    try {
      const userId = req.user.user_id;

      const p = await sql.query`
        SELECT patient_id FROM Patients WHERE user_id = ${userId}
      `;
      if (!p.recordset.length) {
        return res.status(404).json({ error: "Patient record not found" });
      }
      const patient_id = p.recordset[0].patient_id;

      const recs = await sql.query`
        SELECT
          record_id,
          patient_id,
          file_path,
          uploaded_at,
          RIGHT(file_path, CHARINDEX('/', REVERSE(file_path) + '/') - 1) AS file_name
        FROM MedicalRecords
        WHERE patient_id = ${patient_id}
        ORDER BY uploaded_at DESC
      `;
      res.json(recs.recordset);
    } catch (err) {
      console.error("❌ Patient records error:", err.message);
      res.status(500).json({ error: "Failed to fetch records" });
    }
  }
);

export default router;

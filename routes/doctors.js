// routes/doctors.js
import express from "express";
import sql from "mssql";
import { authenticate, authorizeRole } from "../middleware/auth.js";

const router = express.Router();

/* Public: list for dropdowns */
router.get("/list", async (_req, res) => {
  try {
    const result = await sql.query`
      SELECT d.doctor_id, u.full_name, d.specialization
      FROM Doctors d
      JOIN Users u ON d.user_id = u.user_id
      ORDER BY u.full_name
    `;
    res.json(result.recordset);
  } catch (err) {
    console.error("❌ Doctor list error:", err.message);
    res.status(500).json({ error: "Failed to load doctors" });
  }
});

/* Public: availability for slot picker */
router.get("/:id/availability", async (req, res) => {
  try {
    const { id } = req.params;

    const doctorRes = await sql.query`
      SELECT doctor_id, available_days
      FROM Doctors
      WHERE doctor_id = ${id}
    `;
    if (!doctorRes.recordset.length) {
      return res.status(404).json({ error: "Doctor not found" });
    }
    const doctor = doctorRes.recordset[0];

    const apptRes = await sql.query`
      SELECT appointment_date
      FROM Appointments
      WHERE doctor_id = ${id}
        AND status = 'Scheduled'
        AND appointment_date >= GETDATE()
    `;

    res.json({
      doctor_id: doctor.doctor_id,
      available_days: doctor.available_days,
      working_hours: {
        start: "10:00",
        end: "17:00",
        lunch: ["14:00", "15:00"],
      },
      booked: apptRes.recordset.map((a) => a.appointment_date),
    });
  } catch (err) {
    console.error("❌ Availability error:", err.message);
    res.status(500).json({ error: "Failed to fetch availability" });
  }
});

/* Provider: their own profile */
router.get("/me", authenticate, authorizeRole("Provider"), async (req, res) => {
  try {
    const result = await sql.query`
        SELECT 
          u.full_name,
          u.email,
          u.phone_number,
          d.specialization,
          d.available_days,
          d.experience_years
        FROM Doctors d
        JOIN Users u ON d.user_id = u.user_id
        WHERE d.user_id = ${req.user.user_id}
      `;
    if (!result.recordset.length) {
      return res.status(404).json({ error: "Doctor profile not found" });
    }
    res.json(result.recordset[0]);
  } catch (err) {
    console.error("❌ Doctor /me error:", err.message);
    res.status(500).json({ error: "Failed to load profile" });
  }
});

/* Provider: only their own patients (gender shown, not address/phone) */
router.get(
  "/patients",
  authenticate,
  authorizeRole("Provider"),
  async (req, res) => {
    try {
      // resolve doctor_id for logged-in provider
      const d = await sql.query`
        SELECT doctor_id FROM Doctors WHERE user_id = ${req.user.user_id}
      `;
      if (!d.recordset.length) {
        return res.status(404).json({ error: "Doctor profile not found" });
      }
      const doctorId = d.recordset[0].doctor_id;

      // only patients who have appointments with this doctor
      const result = await sql.query`
        SELECT DISTINCT
          p.patient_id,
          u.full_name,
          p.gender
        FROM Appointments a
        JOIN Patients p ON p.patient_id = a.patient_id
        JOIN Users u    ON u.user_id    = p.user_id
        WHERE a.doctor_id = ${doctorId}
        ORDER BY u.full_name
      `;
      res.json(result.recordset);
    } catch (err) {
      console.error("❌ Fetch patients error:", err.message);
      res.status(500).json({ error: "Failed to fetch patients" });
    }
  }
);

/* Provider: appointments for a specific patient — but only with THIS doctor */
router.get(
  "/patient/:patientId/appointments",
  authenticate,
  authorizeRole("Provider"),
  async (req, res) => {
    try {
      const pid = Number(req.params.patientId);
      // resolve doctor_id for provider
      const d = await sql.query`
        SELECT doctor_id FROM Doctors WHERE user_id = ${req.user.user_id}
      `;
      if (!d.recordset.length) {
        return res.status(404).json({ error: "Doctor profile not found" });
      }
      const doctorId = d.recordset[0].doctor_id;

      const result = await sql.query`
        SELECT appointment_id, appointment_date, status, doctor_id, patient_id
        FROM Appointments
        WHERE patient_id = ${pid} 
        ORDER BY appointment_date DESC
      `;
      res.json(result.recordset);
    } catch (err) {
      console.error("❌ Fetch appointments error:", err.message);
      res.status(500).json({ error: "Failed to fetch appointments" });
    }
  }
);

/* Provider: a patient's records (unchanged) */
router.get(
  "/patient/:patientId/records",
  authenticate,
  authorizeRole("Provider"),
  async (req, res) => {
    try {
      const pid = Number(req.params.patientId);
      const d = await sql.query`
        SELECT doctor_id FROM Doctors WHERE user_id = ${req.user.user_id}
      `;
      if (!d.recordset.length) {
        return res.status(404).json({ error: "Doctor profile not found" });
      }
      const doctorId = d.recordset[0].doctor_id;

      const result = await sql.query`
        SELECT
          record_id, patient_id, file_path, uploaded_at,
          RIGHT(file_path, CHARINDEX('/', REVERSE(file_path) + '/') - 1) AS file_name
        FROM MedicalRecords
        WHERE patient_id = ${pid} AND doctor_id = ${doctorId}
        ORDER BY uploaded_at DESC
      `;
      res.json(result.recordset);
    } catch (err) {
      console.error("❌ Fetch records error:", err.message);
      res.status(500).json({ error: "Failed to fetch records" });
    }
  }
);

export default router;

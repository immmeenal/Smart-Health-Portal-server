// routes/appointments.js
import express from "express";
import sql from "mssql";
import jwt from "jsonwebtoken";

const router = express.Router();

/* ----------------- Auth helpers ----------------- */
function authMiddleware(req, res, next) {
  const token = (req.headers["authorization"] || "").split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token provided" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET); // { user_id, role }
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}
const isRole = (role, ...allowed) =>
  allowed.map(r => r.toLowerCase()).includes((role || "").toLowerCase());

/* ----------------- Utils ----------------- */
const pad = (n) => String(n).padStart(2, "0");

/**
 * Convert date + time strings to parts the proc expects, WITHOUT timezone math.
 * - dateStr: "YYYY-MM-DD"
 * - timeStr: "HH:mm" or "HH:mm:ss"
 *
 * Returns:
 *   { dateOnly: "YYYY-MM-DD", timeOnly: "HH:mm:ss", dbgTime: "HH:mm:ss" }
 */
function splitToDateAndTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) throw new Error("date and time are required");

  const t = timeStr.length === 5 ? `${timeStr}:00` : timeStr; // normalize to HH:mm:ss
  const m = t.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) throw new Error("Invalid time; expected HH:mm or HH:mm:ss");

  const hh = Number(m[1]), mm = Number(m[2]), ss = Number(m[3]);
  if (hh > 23 || mm > 59 || ss > 59) throw new Error("Invalid time components");

  // IMPORTANT: return timeOnly as PLAIN STRING to avoid TZ shifts
  return { dateOnly: dateStr, timeOnly: `${pad(hh)}:${pad(mm)}:${pad(ss)}`, dbgTime: t };
}

/* ============== Routes ============== */

/**
 * Patient books an appointment using dbo.ScheduleAppointment
 * Body: { doctor_id, date: "YYYY-MM-DD", time: "HH:mm[:ss]" }
 */
router.post("/my", authMiddleware, async (req, res) => {
  try {
    if (!isRole(req.user.role, "Patient")) {
      return res.status(403).json({ error: "Only patients can book appointments" });
    }

    const { doctor_id, date, time } = req.body;
    if (!doctor_id || !date || !time) {
      return res.status(400).json({ error: "doctor_id, date, and time are required" });
    }

    // resolve patient_id from JWT user_id
    const p = await sql.query`
      SELECT patient_id FROM Patients WHERE user_id = ${req.user.user_id}
    `;
    if (!p.recordset.length) {
      return res.status(404).json({ error: "Patient record not found for this user" });
    }
    const patient_id = p.recordset[0].patient_id;

    const { dateOnly, timeOnly, dbgTime } = splitToDateAndTime(date, time);

    console.log("Booking request (EXEC dbo.ScheduleAppointment):", {
      jwt_user_id: req.user.user_id,
      resolved_patient_id: patient_id,
      doctor_id: Number(doctor_id),
      dateOnly,
      dbgTime,
      // show string to prove it's not a Date with TZ
      timeOnlyString: timeOnly
    });

    const result = await new sql.Request()
      .input("patient_id", sql.Int, patient_id)
      .input("doctor_id", sql.Int, Number(doctor_id))
      .input("appointment_date", sql.Date, dateOnly)
      // CRITICAL: pass time as VarChar to avoid timezone conversions
      .input("appointment_time", sql.VarChar, timeOnly)
      .execute("dbo.ScheduleAppointment");

    const appointment_id = result.recordset?.[0]?.appointment_id;
    if (!appointment_id) {
      return res.status(500).json({ error: "SP did not return appointment_id" });
    }
    res.status(201).json({ appointment_id });
  } catch (err) {
    const num = err?.originalError?.info?.number || err?.number;
    const msg = err?.originalError?.info?.message || err.message;
    console.error("EXEC error:", { num, msg, raw: err });

    // Surface your SP’s custom guards
    if ([50001, 50002, 50003, 50004, 50005, 50006].includes(num)) {
      return res.status(400).json({ error: msg });
    }
    // FK errors etc.
    if (num === 547) {
      return res.status(400).json({ error: msg });
    }
    return res.status(500).json({ error: "Failed to book appointment" });
  }
});

/**
 * Logged-in patient's appointments
 */
router.get("/my", authMiddleware, async (req, res) => {
  try {
    if (!isRole(req.user.role, "Patient")) {
      return res.status(403).json({ error: "Only patients can view this" });
    }
    const p = await sql.query`
      SELECT patient_id FROM Patients WHERE user_id = ${req.user.user_id}
    `;
    if (!p.recordset.length) return res.status(404).json({ error: "Patient not found" });
    const patient_id = p.recordset[0].patient_id;

    const result = await sql.query`
      SELECT * FROM Appointments
      WHERE patient_id = ${patient_id}
      ORDER BY appointment_date DESC
    `;
    res.json(result.recordset);
  } catch (err) {
    console.error("❌ My appointments error:", err);
    res.status(500).json({ error: "Failed to fetch appointments" });
  }
});

/**
 * Update appointment status
 * Body: { status: "Scheduled" | "Completed" | "Cancelled" }
 */
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!["Scheduled", "Completed", "Cancelled"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const result = await sql.query`
      UPDATE Appointments
      SET status = ${status}
      WHERE appointment_id = ${id};
      SELECT @@ROWCOUNT AS affected;
    `;
    if (result.recordset[0].affected === 0) {
      return res.status(404).json({ error: "Appointment not found" });
    }
    res.json({ message: "Appointment updated" });
  } catch (err) {
    console.error("❌ Update error:", err);
    res.status(500).json({ error: "Failed to update appointment" });
  }
});

/**
 * Soft delete (Cancel) appointment + remove unsent notifications
 * Keeps FK integrity with Notifications table.
 */
router.delete("/:id", authMiddleware, async (req, res) => {
  const tx = new sql.Transaction();
  try {
    await tx.begin();
    const request = new sql.Request(tx);

    // 1) mark as cancelled
    const upd = await request.query`
      UPDATE Appointments SET status = 'Cancelled'
      WHERE appointment_id = ${req.params.id};
      SELECT @@ROWCOUNT AS affected;
    `;
    const affected = upd.recordset?.[0]?.affected || 0;
    if (affected === 0) {
      await tx.rollback();
      return res.status(404).json({ error: "Appointment not found" });
    }

    // 2) delete any pending notifications so reminders don't fire
    await request.query`
      DELETE FROM Notifications
      WHERE appointment_id = ${req.params.id}
        AND (sent_at IS NULL OR sent_at = '')
    `;

    await tx.commit();
    res.json({ message: "Appointment cancelled" });
  } catch (err) {
    await tx.rollback().catch(() => {});
    console.error("Cancel error:", err);
    res.status(500).json({ error: "Failed to cancel appointment" });
  }
});

export default router;

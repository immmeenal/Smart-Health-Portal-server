// routes/appointments.js
import express from "express";
import sql from "mssql";
import jwt from "jsonwebtoken";
import { sendEmail } from "../utils/email.js";

const router = express.Router();

/* ----------------- Auth helpers ----------------- */
function auth(req, res, next) {
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
  allowed.map((r) => r.toLowerCase()).includes((role || "").toLowerCase());

/* ----------------- Utils ----------------- */
const pad = (n) => String(n).padStart(2, "0");

// normalize "YYYY-MM-DD" + "HH:mm[:ss]" into parts for the stored proc
function splitToDateAndTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) throw new Error("date and time are required");

  const t = timeStr.length === 5 ? `${timeStr}:00` : timeStr; // normalize to HH:mm:ss
  const m = t.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) throw new Error("Invalid time; expected HH:mm or HH:mm:ss");

  const hh = Number(m[1]),
    mm = Number(m[2]),
    ss = Number(m[3]);
  if (hh > 23 || mm > 59 || ss > 59) throw new Error("Invalid time components");

  // IMPORTANT: return timeOnly as PLAIN STRING (avoid TZ conversions)
  return {
    dateOnly: dateStr,
    timeOnly: `${pad(hh)}:${pad(mm)}:${pad(ss)}`,
    dbgTime: t,
  };
}

async function getPatientIdForUser(userId) {
  const r =
    await sql.query`SELECT patient_id FROM Patients WHERE user_id=${userId}`;
  return r.recordset[0]?.patient_id || null;
}

/* =========================================================
   POST /api/appointments/my
   Patient books via dbo.ScheduleAppointment(date, time)
   Body: { doctor_id, date: "YYYY-MM-DD", time: "HH:mm" | "HH:mm:ss" }
   ========================================================= */
router.post("/my", auth, async (req, res) => {
  try {
    if (!isRole(req.user.role, "Patient")) {
      return res
        .status(403)
        .json({ error: "Only patients can book appointments" });
    }

    const { doctor_id, date, time } = req.body;
    if (!doctor_id || !date || !time) {
      return res
        .status(400)
        .json({ error: "doctor_id, date, and time are required" });
    }

    const patient_id = await getPatientIdForUser(req.user.user_id);
    if (!patient_id)
      return res.status(404).json({ error: "Patient record not found" });

    const { dateOnly, timeOnly } = splitToDateAndTime(date, time);

    // Execute SP (send time as VarChar to avoid TZ issues)
    const result = await new sql.Request()
      .input("patient_id", sql.Int, Number(patient_id))
      .input("doctor_id", sql.Int, Number(doctor_id))
      .input("appointment_date", sql.Date, dateOnly)
      .input("appointment_time", sql.VarChar, timeOnly)
      .execute("dbo.ScheduleAppointment");

    const appointment_id = result.recordset?.[0]?.appointment_id;
    if (!appointment_id)
      return res
        .status(500)
        .json({ error: "SP did not return appointment_id" });

    // === Send confirmation email (best effort) & log Notification ===
    // inside routes/appointments.js, after you get appointment_id
    try {
      const info = await sql.query`
    SELECT 
      u.email       AS patient_email,
      u.full_name   AS patient_name,
      a.appointment_date,
      du.full_name  AS doctor_name
    FROM Appointments a
    JOIN Patients p   ON a.patient_id = p.patient_id
    JOIN Users u      ON p.user_id    = u.user_id
    JOIN Doctors d    ON a.doctor_id  = d.doctor_id
    JOIN Users du     ON d.user_id    = du.user_id
    WHERE a.appointment_id = ${appointment_id}
  `;

      const row = info.recordset[0];
      const toEmail = (row?.patient_email ?? "").toString().trim();
      const docName = (row?.doctor_name ?? "").toString();
      const patName = (row?.patient_name ?? "").toString();
      function fmtClinic(dt) {
        const d = new Date(dt);
        // subtract 5h30m
        d.setMinutes(d.getMinutes() - 330);
        return new Intl.DateTimeFormat("en-IN", {
          timeZone: "Asia/Kolkata",
          year: "numeric",
          month: "numeric",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        }).format(d);
      }

      const whenIST = fmtClinic(row?.appointment_date);

      let sentOK = false;

      try {
        await sendEmail({
          to: toEmail,
          subject: `Appointment Confirmed with ${docName}`,
          html: `
        <p>Hi ${patName || "there"},</p>
        <p>Your appointment with <b>${
          docName || "our provider"
        }</b> is confirmed for 
        <b>${whenIST}</b>.</p>
        <p>Thanks!</p>
      `,
        });
        sentOK = true;
      } catch (e) {
        console.warn("Confirmation email send failed:", e?.message || e);
      }

      if (sentOK) {
        await sql.query`
      INSERT INTO Notifications (appointment_id, sent_at, status)
      VALUES (${appointment_id}, GETUTCDATE(), 'Sent')
    `;
      } else {
        await sql.query`
      INSERT INTO Notifications (appointment_id, sent_at, status)
      VALUES (${appointment_id}, NULL, 'Failed')
    `;
      }
    } catch (e) {
      console.warn("⚠️ Confirmation logging failed:", e?.message || e);
    }

    return res.status(201).json({ appointment_id });
  } catch (err) {
    const num = err?.originalError?.info?.number || err?.number;
    const msg = err?.originalError?.info?.message || err.message;

    // surface your SP guard messages
    if ([50001, 50002, 50003, 50004, 50005, 50006].includes(num)) {
      return res.status(400).json({ error: msg });
    }
    if (num === 547) {
      // FK errors
      return res.status(400).json({ error: msg });
    }
    console.error("❌ Create /my error:", err);
    return res.status(500).json({ error: "Failed to book appointment" });
  }
});

/* =========================================================
   GET /api/appointments/my
   Logged-in patient's appointments
   ========================================================= */

// routes/appointments.js (GET /api/appointments/my)
router.get("/my", auth, async (req, res) => {
  try {
    if (req.user.role.toLowerCase() !== "patient") {
      return res.status(403).json({ error: "Only patients can view this" });
    }

    const p = await sql.query`
      SELECT patient_id FROM Patients WHERE user_id = ${req.user.user_id}
    `;
    if (!p.recordset.length)
      return res.status(404).json({ error: "Patient not found" });
    const patient_id = p.recordset[0].patient_id;

    // IMPORTANT: return appointment_date plus a pre-formatted IST string
    const result = await sql.query`
      SELECT 
        a.appointment_id,
        a.patient_id,
        a.doctor_id,
        a.status,
        a.appointment_date,
        -- Display in IST so the UI can render text directly (no Date parsing)
        FORMAT(
          SWITCHOFFSET(CONVERT(datetimeoffset, a.appointment_date), '+05:30'),
          'd MMM yyyy, h:mm tt', 'en-IN'
        ) AS display_time
      FROM Appointments a
      WHERE a.patient_id = ${patient_id}
      ORDER BY a.appointment_date DESC
    `;

    res.json(result.recordset);
  } catch (err) {
    console.error("❌ My appointments error:", err);
    res.status(500).json({ error: "Failed to fetch appointments" });
  }
});
//fetch booked slots for a given doctor & date
// routes/appointments.js
router.get("/doctor/:doctorId/booked", auth, async (req, res) => {
  try {
    const doctorId = Number(req.params.doctorId);
    const { date } = req.query; // YYYY-MM-DD

    if (!doctorId || !date) {
      return res.status(400).json({ error: "doctorId and date are required" });
    }

    // get all appointments for that doctor on that date (not cancelled)
    const result = await sql.query`
      SELECT appointment_date
      FROM Appointments
      WHERE doctor_id = ${doctorId}
        AND CAST(appointment_date AS date) = ${date}
        AND status != 'Cancelled'
        AND appointment_date > GETUTCDATE() -- filter out past times
    `;

    // return raw datetime values (backend UTC)
    res.json(result.recordset.map((r) => r.appointment_date));
  } catch (err) {
    console.error("❌ Fetch booked slots error:", err);
    res.status(500).json({ error: "Failed to fetch booked slots" });
  }
});

router.get("/doctor/appointments", auth, async (req, res) => {
  try {
    // step 1: map logged in user → doctor_id
    const docRes = await sql.query`
      SELECT doctor_id 
      FROM Doctors 
      WHERE user_id = ${req.user.user_id}
    `;
    if (!docRes.recordset.length) {
      return res.status(403).json({ error: "Not a valid doctor" });
    }
    const doctorId = docRes.recordset[0].doctor_id;

    const { date } = req.query; // YYYY-MM-DD
    if (!date) {
      return res.status(400).json({ error: "date is required" });
    }

    // // Debug logs
    // console.log("DoctorId:", doctorId, "Date:", date);

    const result = await sql.query`
      SELECT a.appointment_id, 
             a.appointment_date, 
             a.status,
             p.patient_id, 
             u.full_name AS patient_name
      FROM Appointments a
      JOIN Patients p ON a.patient_id = p.patient_id
      JOIN Users u ON p.user_id = u.user_id
      WHERE a.doctor_id = ${doctorId}
        AND CAST(a.appointment_date AS DATE) = CAST(${date} AS DATE)
        AND a.status != 'Cancelled'
      ORDER BY a.appointment_date ASC
    `;

    res.json(result.recordset);
  } catch (err) {
    console.error("❌ Search appointments error:", err);
    res.status(500).json({ error: "Failed to fetch appointments" });
  }
});

/* =========================================================
   PUT /api/appointments/:id
   Update appointment status
   Body: { status: "Scheduled" | "Completed" | "Cancelled" }
   ========================================================= */
router.put("/:id", auth, async (req, res) => {
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

/* =========================================================
   DELETE /api/appointments/:id
   Soft cancel appointment + clear unsent notifications
   ========================================================= */
// CANCEL (soft-delete) an appointment and remove pending notifications
/* ----------------- Time helpers ----------------- */
function addISTOffset(date) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - 330); // +5h30m
  return d;
}

function formatIST(date) {
  return new Intl.DateTimeFormat("en-IN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(date));
}

// CANCEL (soft-delete) an appointment and remove pending notifications
router.delete("/:id", auth, async (req, res) => {
  const apptId = Number(req.params.id);
  if (!apptId) return res.status(400).json({ error: "Invalid appointment id" });

  const tx = new sql.Transaction();
  try {
    await tx.begin();

    // 1) mark as Cancelled
    let affected = 0;
    {
      const r1 = new sql.Request(tx);
      r1.input("id", sql.Int, apptId);
      const upd = await r1.query(`
        UPDATE Appointments
        SET status = 'Cancelled'
        WHERE appointment_id = @id;

        SELECT @@ROWCOUNT AS affected;
      `);
      affected = upd.recordset?.[0]?.affected || 0;
      if (affected === 0) {
        await tx.rollback();
        return res.status(404).json({ error: "Appointment not found" });
      }
    }

    // 2) remove NOT YET sent notifications
    {
      const r2 = new sql.Request(tx);
      r2.input("id", sql.Int, apptId);
      await r2.query(`
        DELETE FROM Notifications
        WHERE appointment_id = @id
          AND (sent_at IS NULL)
      `);
    }

    await tx.commit();

    // 3) Fetch patient + doctor details
    const info = await sql.query`
      SELECT 
        a.appointment_date,
        pu.email     AS patient_email,
        pu.full_name AS patient_name,
        du.full_name AS doctor_name
      FROM Appointments a
      JOIN Patients p ON a.patient_id = p.patient_id
      JOIN Users pu   ON p.user_id    = pu.user_id
      JOIN Doctors d  ON a.doctor_id  = d.doctor_id
      JOIN Users du   ON d.user_id    = du.user_id
      WHERE a.appointment_id = ${apptId}
    `;

    const row = info.recordset[0];
    if (row) {
      const whenIST = formatIST(row.appointment_date);

      try {
        await sendEmail({
          to: row.patient_email,
          subject: `Appointment with ${row.doctor_name} canceled`,
          html: `
            <p>Hi ${row.patient_name},</p>
            <p>Your appointment with <b>${row.doctor_name}</b> is canceled for <b>${whenIST}</b>.</p>
            <p>Thanks!</p>
          `,
        });
      } catch (e) {
        console.warn("❌ Cancel email failed:", e?.message || e);
      }
    }

    res.json({ message: "Appointment cancelled and email sent" });
  } catch (err) {
    try {
      await tx.rollback();
    } catch {}
    console.error("Cancel error:", err);
    res.status(500).json({ error: "Failed to cancel appointment" });
  }
});

export default router;

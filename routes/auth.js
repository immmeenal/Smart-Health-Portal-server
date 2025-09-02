// routes/auth.js
import express from "express";
import sql from "mssql";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const router = express.Router();

// REGISTER
router.post("/register", async (req, res) => {
  const { full_name, email, password, phone_number, user_role } = req.body;

  try {
    // 1. Check if email exists
    const checkUser =
      await sql.query`SELECT * FROM Users WHERE email = ${email}`;
    if (checkUser.recordset.length > 0) {
      return res.status(400).json({ error: "Email already exists" });
    }

    // 2. Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // 3. Normalize role (important!)
    let role = user_role;
    if (role.toLowerCase() === "doctor") role = "Provider";
    if (role.toLowerCase() === "patient") role = "Patient";

    // 4. Insert into Users
    const result = await sql.query`
      INSERT INTO Users (full_name, email, password_hash, phone_number, user_role, created_at)
      OUTPUT INSERTED.user_id
      VALUES (${full_name}, ${email}, ${hashedPassword}, ${phone_number}, ${role}, GETDATE())
    `;

    const userId = result.recordset[0].user_id;

    // 5. Insert into Doctors
    // inside POST /register after you obtained userId
    if (role === "Provider") {
      // accept what the UI sent; fall back only if truly empty
      const avail = (req.body.available_days || "").trim() || "Mon,Wed,Fri";
      const exp = Number(req.body.experience_years) || 0;
      const spec = req.body.specialization || "General";

      await sql.query`
    INSERT INTO Doctors (user_id, specialization, experience_years, available_days, created_at)
    VALUES (${userId}, ${spec}, ${exp}, ${avail}, GETDATE())
  `;
    }

    // 6. Insert into Patients
    if (role === "Patient") {
      const { date_of_birth, gender, address, emergency_contact } = req.body;

      await sql.query`
    INSERT INTO Patients (user_id, date_of_birth, gender, address, emergency_contact, created_at)
    VALUES (
      ${userId},
      ${date_of_birth},
      ${gender || "Unknown"},
      ${address || "N/A"},
      ${emergency_contact || "N/A"},
      GETDATE()
    )
  `;
    }

    res.json({ message: "User registered successfully", user_id: userId });
  } catch (err) {
    console.error("❌ Register Error:", err.message);
    res.status(500).json({ error: "Failed to register user" });
  }
});

// LOGIN
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await sql.query`SELECT * FROM Users WHERE email=${email}`;
    if (result.recordset.length === 0) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const user = result.recordset[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // 🔑 JWT
    const token = jwt.sign(
      { user_id: user.user_id, role: user.user_role },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    // 📌 Fetch extra info
    let extraInfo = {};
    if (user.user_role === "Patient") {
      const patientRes = await sql.query`
        SELECT patient_id FROM Patients WHERE user_id = ${user.user_id}
      `;
      if (patientRes.recordset.length > 0) {
        extraInfo.patient_id = patientRes.recordset[0].patient_id;
      }
    } else if (user.user_role === "Provider") {
      const doctorRes = await sql.query`
        SELECT doctor_id FROM Doctors WHERE user_id = ${user.user_id}
      `;
      if (doctorRes.recordset.length > 0) {
        extraInfo.doctor_id = doctorRes.recordset[0].doctor_id;
      }
    }

    res.json({
      token,
      role: user.user_role,
      full_name: user.full_name,
      user_id: user.user_id,
      ...extraInfo,
    });
  } catch (err) {
    console.error("❌ Login Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/me", (req, res) => {
  try {
    const token = (req.headers["authorization"] || "").split(" ")[1];
    if (!token) return res.status(401).json({ error: "No token" });
    const u = jwt.verify(token, process.env.JWT_SECRET); // { user_id, role }
    res.json(u);
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
});

export default router;

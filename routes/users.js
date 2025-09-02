import bcrypt from "bcrypt"; // if using ES module
// or
const bcrypt = require("bcrypt"); // if using require

// Register user
router.post("/register", async (req, res) => {
  try {
    const {
      full_name,
      email,
      password,
      phone_number,
      user_role,
      date_of_birth,
      gender,
      address,
      emergency_contact,
    } = req.body;

    const pool = await getPool();

    // Hash password before saving
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Insert into Users
    const result = await pool
      .request()
      .input("full_name", full_name)
      .input("email", email)
      .input("password_hash", hashedPassword) // store hashed
      .input("phone_number", phone_number)
      .input("user_role", user_role).query(`
        INSERT INTO Users (full_name, email, password_hash, phone_number, user_role)
        VALUES (@full_name, @email, @password_hash, @phone_number, @user_role);
        SELECT SCOPE_IDENTITY() as user_id;
      `);

    const user_id = result.recordset[0].user_id;

    // If role is Patient, insert extra details into Patients table
    if (user_role === "Patient") {
      await pool
        .request()
        .input("user_id", user_id)
        .input("date_of_birth", date_of_birth || null)
        .input("gender", gender || "Unknown")
        .input("address", address || "N/A")
        .input("emergency_contact", emergency_contact || "N/A").query(`
          INSERT INTO Patients (user_id, date_of_birth, gender, address, emergency_contact)
          VALUES (@user_id, @date_of_birth, @gender, @address, @emergency_contact)
        `);
    }

    res.json({ user_id });
  } catch (err) {
    console.error("❌ Register error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

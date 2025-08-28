const express = require("express");
const router = express.Router();
const { getPool } = require("../db");

// Register user
router.post("/register", async (req, res) => {
  try {
    const { full_name, email, password_hash, phone_number, user_role } = req.body;
    const pool = await getPool();
    const result = await pool.request()
      .input("full_name", full_name)
      .input("email", email)
      .input("password_hash", password_hash)
      .input("phone_number", phone_number)
      .input("user_role", user_role)
      .query(`
        INSERT INTO Users (full_name, email, password_hash, phone_number, user_role)
        VALUES (@full_name, @email, @password_hash, @phone_number, @user_role);
        SELECT SCOPE_IDENTITY() as user_id;
      `);
    res.json({ user_id: result.recordset[0].user_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login (simple)
router.post("/login", async (req, res) => {
  try {
    const { email, password_hash } = req.body;
    const pool = await getPool();
    const result = await pool.request()
      .input("email", email)
      .input("password_hash", password_hash)
      .query(`SELECT user_id, full_name, user_role FROM Users WHERE email=@email AND password_hash=@password_hash`);
    if (result.recordset.length === 0) return res.status(401).json({ error: "Invalid credentials" });
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

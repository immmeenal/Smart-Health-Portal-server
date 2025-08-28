const sql = require("mssql");

const config = {
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  server: process.env.SQL_SERVER,   // e.g. healthcare.database.windows.net
  database: process.env.SQL_DB,
  options: {
    encrypt: true,
    trustServerCertificate: false
  }
};

async function getPool() {
  const pool = await sql.connect(config);
  return pool;
}

module.exports = { getPool };

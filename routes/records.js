import express from "express";
import sql from "mssql";
import multer from "multer";
import { BlobServiceClient } from "@azure/storage-blob";
import jwt from "jsonwebtoken";

const router = express.Router();

// 10 MB limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

/* -------------------- Auth helpers -------------------- */
function auth(req, res, next) {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.split(" ")[1];
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

async function getPatientIdForUser(userId) {
  const r = await sql.query`SELECT patient_id FROM Patients WHERE user_id=${userId}`;
  return r.recordset[0]?.patient_id || null;
}
async function getDoctorIdForUser(userId) {
  const r = await sql.query`SELECT doctor_id FROM Doctors WHERE user_id=${userId}`;
  return r.recordset[0]?.doctor_id || null;
}

function safeName(name = "file") {
  const dot = name.lastIndexOf(".");
  const base = (dot > -1 ? name.slice(0, dot) : name).replace(/[^\w\-]+/g, "_");
  const ext = dot > -1 ? name.slice(dot).replace(/[^\.\w]+/g, "") : "";
  return `${base}${ext}`;
}

/* -------------------- Lazy Blob client (cached) -------------------- */
let _containerClient = null;
async function getContainerClient() {
  if (_containerClient) return _containerClient;

  const connStr =
    process.env.AZURE_STORAGE_CONNECTION_STRING ||
    process.env.STORAGE_CONNECTION_STRING;

  if (!connStr) {
    throw new Error(
      "Missing Azure Blob connection string. Set AZURE_STORAGE_CONNECTION_STRING (preferred) or STORAGE_CONNECTION_STRING in your .env"
    );
  }

  const containerName = (process.env.AZURE_BLOB_CONTAINER || "medical-files").trim();
  const blobServiceClient = BlobServiceClient.fromConnectionString(connStr);
  const containerClient = blobServiceClient.getContainerClient(containerName);
  await containerClient.createIfNotExists(); // default is private

  _containerClient = containerClient;
  return _containerClient;
}

/* -------------------- Ping (for quick mount test) -------------------- */
router.get("/ping", (_req, res) => res.json({ ok: true, where: "records" }));

/* -------------------- Upload -------------------- */
/**
 * POST /api/records/upload
 * - Patient: uploads for self (no patientId in form)
 * - Provider: must include form field `patientId` (Patients.patient_id)
 * Body: multipart/form-data with key "file"
 */
router.post("/upload", auth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided" });

    let patientId;
    if (isRole(req.user.role, "patient")) {
      patientId = await getPatientIdForUser(req.user.user_id);
    } else if (isRole(req.user.role, "provider")) {
      patientId = Number(req.body.patientId);
    } else {
      return res.status(403).json({ error: "Not allowed" });
    }
    if (!patientId) return res.status(400).json({ error: "Missing patientId" });

    const containerClient = await getContainerClient();

    const original = safeName(req.file.originalname || "file");
    const blobName = `${Date.now()}-${original}`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    await blockBlobClient.uploadData(req.file.buffer, {
      blobHTTPHeaders: {
        blobContentType: req.file.mimetype || "application/octet-stream",
      },
    });

    await sql.query`
      INSERT INTO MedicalRecords (patient_id, file_path, uploaded_at, blob_container)
      VALUES (${patientId}, ${blockBlobClient.url}, GETUTCDATE(), ${containerClient.containerName})
    `;

    res.json({
      message: "Uploaded",
      url: blockBlobClient.url,
      record_file: blobName,
    });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Failed to upload record" });
  }
});

/* -------------------- List own files (patient) -------------------- */
/**
 * GET /api/records/my
 */
router.get("/my", auth, async (req, res) => {
  try {
    if (!isRole(req.user.role, "patient")) {
      return res.status(403).json({ error: "Only patients can view their files" });
    }
    const pid = await getPatientIdForUser(req.user.user_id);
    if (!pid) return res.status(404).json({ error: "Patient record not found" });

    const r = await sql.query`
      SELECT record_id,
             file_path,
             uploaded_at,
             RIGHT(file_path, CHARINDEX('/', REVERSE(file_path) + '/') - 1) AS file_name
      FROM MedicalRecords
      WHERE patient_id = ${pid}
      ORDER BY uploaded_at DESC
    `;
    res.json(r.recordset);
  } catch (err) {
    console.error("List my records error:", err);
    res.status(500).json({ error: "Failed to fetch records" });
  }
});

/* -------------------- List a patient's files (provider) -------------------- */
/**
 * GET /api/records/patient/:patientId/records
 * Only providers; must have an appointment with the patient.
 */
router.get("/patient/:patientId/records", auth, async (req, res) => {
  try {
    if (!isRole(req.user.role, "provider")) {
      return res.status(403).json({ error: "Only providers can view patient files" });
    }
    const patientId = Number(req.params.patientId);
    if (!patientId) return res.status(400).json({ error: "Invalid patientId" });

    const myDocId = await getDoctorIdForUser(req.user.user_id);
    if (!myDocId) return res.status(403).json({ error: "Doctor profile not found" });

    // Ensure provider has relationship with the patient
    const rel = await sql.query`
      SELECT TOP 1 1 FROM Appointments
      WHERE patient_id = ${patientId} AND doctor_id = ${myDocId}
    `;
    if (!rel.recordset.length) {
      return res.status(403).json({ error: "No relationship with patient" });
    }

    const r = await sql.query`
      SELECT record_id,
             file_path,
             uploaded_at,
             RIGHT(file_path, CHARINDEX('/', REVERSE(file_path) + '/') - 1) AS file_name
      FROM MedicalRecords
      WHERE patient_id = ${patientId}
      ORDER BY uploaded_at DESC
    `;
    res.json(r.recordset);
  } catch (err) {
    console.error("Doctor list records error:", err);
    res.status(500).json({ error: "Failed to fetch records" });
  }
});

/* -------------------- Delete a record -------------------- */
/**
 * DELETE /api/records/:recordId
 * Patient: can delete own file
 * Provider: can delete only if they have an appointment with that patient
 */
router.delete("/:recordId", auth, async (req, res) => {
  try {
    const recordId = Number(req.params.recordId);
    if (!recordId) return res.status(400).json({ error: "Invalid recordId" });

    const rec = await sql.query`
      SELECT TOP 1 record_id, patient_id, file_path
      FROM MedicalRecords
      WHERE record_id = ${recordId}
    `;
    if (!rec.recordset.length) return res.status(404).json({ error: "Record not found" });
    const { patient_id, file_path } = rec.recordset[0];

    if (isRole(req.user.role, "patient")) {
      const myPid = await getPatientIdForUser(req.user.user_id);
      if (myPid !== patient_id) return res.status(403).json({ error: "Not allowed" });
    } else if (isRole(req.user.role, "provider")) {
      const myDocId = await getDoctorIdForUser(req.user.user_id);
      if (!myDocId) return res.status(403).json({ error: "Doctor profile not found" });
      const hasRel = await sql.query`
        SELECT TOP 1 1 FROM Appointments
        WHERE patient_id = ${patient_id} AND doctor_id = ${myDocId}
      `;
      if (!hasRel.recordset.length) return res.status(403).json({ error: "Not allowed" });
    } else {
      return res.status(403).json({ error: "Not allowed" });
    }

    // Try to delete blob (best-effort)
    try {
      const containerClient = await getContainerClient();
      const blobName = (file_path || "").split("/").pop();
      if (blobName) {
        const blobClient = containerClient.getBlockBlobClient(blobName);
        await blobClient.deleteIfExists();
      }
    } catch (e) {
      console.warn("Blob delete warning:", e?.message);
    }

    await sql.query`DELETE FROM MedicalRecords WHERE record_id = ${recordId}`;
    res.json({ message: "Record deleted" });
  } catch (err) {
    console.error("Delete record error:", err);
    res.status(500).json({ error: "Failed to delete record" });
  }
});

export default router;

// routes/records.js
import express from "express";
import sql from "mssql";
import multer from "multer";
import jwt from "jsonwebtoken";
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} from "@azure/storage-blob";

const router = express.Router();

// ---------- auth ----------
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
const isRole = (r, ...allowed) =>
  allowed.map((x) => x.toLowerCase()).includes((r || "").toLowerCase());

// ---------- DB helpers ----------
async function getPatientIdForUser(userId) {
  const r =
    await sql.query`SELECT patient_id FROM Patients WHERE user_id=${userId}`;
  return r.recordset[0]?.patient_id || null;
}
async function getDoctorIdForUser(userId) {
  const r =
    await sql.query`SELECT doctor_id FROM Doctors WHERE user_id=${userId}`;
  return r.recordset[0]?.doctor_id || null;
}

async function getDoctorIdByName(name) {
  const r = await sql.query`
    SELECT TOP 1 d.doctor_id
    FROM Doctors d
    JOIN Users u ON d.user_id = u.user_id
    WHERE u.full_name = ${name}
  `;
  return r.recordset[0]?.doctor_id || null;
}

// ---------- Azure Blob helpers ----------
let _containerClient = null;
let _sasSigner = null;

/** Parse creds from env (supports connection string OR account/key) */
function getStorageCredsFromEnv() {
  const connStr =
    process.env.AZURE_STORAGE_CONNECTION_STRING ||
    process.env.STORAGE_CONNECTION_STRING ||
    "";

  let accountName = process.env.AZURE_STORAGE_ACCOUNT || "";
  let accountKey = process.env.AZURE_STORAGE_KEY || "";

  if ((!accountName || !accountKey) && connStr) {
    // Try to parse AccountName/AccountKey from connection string
    const parts = Object.fromEntries(
      connStr.split(";").map((kv) => {
        const [k, ...rest] = kv.split("=");
        return [k?.trim(), rest.join("=").trim()];
      })
    );
    accountName = accountName || parts.AccountName || "";
    accountKey = accountKey || parts.AccountKey || "";
  }

  return {
    connectionString: connStr || null,
    accountName: accountName || null,
    accountKey: accountKey || null,
  };
}

/** Lazy container client (private by default) */
async function getContainerClient() {
  if (_containerClient) return _containerClient;

  const { connectionString, accountName, accountKey } =
    getStorageCredsFromEnv();
  if (!connectionString && !(accountName && accountKey)) {
    throw new Error(
      "Missing Azure Storage credentials. Provide AZURE_STORAGE_CONNECTION_STRING, " +
        "or AZURE_STORAGE_ACCOUNT + AZURE_STORAGE_KEY."
    );
  }

  const containerName = (
    process.env.AZURE_BLOB_CONTAINER || "medical-files"
  ).trim();

  let blobServiceClient;
  if (connectionString) {
    blobServiceClient =
      BlobServiceClient.fromConnectionString(connectionString);
  } else {
    // URL defaults to core.windows.net; if you use a different suffix, add AZURE_BLOB_ENDPOINT
    const endpoint =
      process.env.AZURE_BLOB_ENDPOINT ||
      `https://${accountName}.blob.core.windows.net`;
    const credential = new StorageSharedKeyCredential(accountName, accountKey);
    blobServiceClient = new BlobServiceClient(endpoint, credential);
  }

  const containerClient = blobServiceClient.getContainerClient(containerName);
  await containerClient.createIfNotExists(); // private by default (no {access:"private"})

  _containerClient = containerClient;
  return _containerClient;
}

/** Lazy SAS signer (uses account+key either from env or parsed from conn string) */
function getSasSigner() {
  if (_sasSigner) return _sasSigner;

  const { accountName, accountKey } = getStorageCredsFromEnv();
  if (!accountName || !accountKey) {
    throw new Error(
      "Cannot sign SAS: missing AZURE_STORAGE_ACCOUNT/AZURE_STORAGE_KEY " +
        "or non-parsable connection string."
    );
  }
  _sasSigner = new StorageSharedKeyCredential(accountName, accountKey);
  return _sasSigner;
}

function createBlobSasUrl(containerClient, blobName, minutes = 15) {
  const signer = getSasSigner();
  const expiresOn = new Date();
  expiresOn.setMinutes(expiresOn.getMinutes() + minutes);

  const sas = generateBlobSASQueryParameters(
    {
      containerName: containerClient.containerName,
      blobName,
      permissions: BlobSASPermissions.parse("r"), // read-only
      expiresOn,
    },
    signer
  ).toString();

  return `${containerClient.url}/${blobName}?${sas}`;
}

function safeName(name = "file") {
  const dot = name.lastIndexOf(".");
  const base = (dot > -1 ? name.slice(0, dot) : name).replace(/[^\w\-]+/g, "_");
  const ext = dot > -1 ? name.slice(dot).replace(/[^\.\w]+/g, "") : "";
  return `${base}${ext}`;
}

// ---------- Multer ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

// =======================================================
//                      ROUTES
// Base path mounted as /api/records
// =======================================================

/**
 * POST /api/records/upload
 * - Patient: uploads for self
 * - Provider: must pass form field patientId
 * Body: multipart/form-data with "file"
 */
router.post("/upload", auth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided" });

    let patientId, doctorId;

    if (isRole(req.user.role, "patient")) {
      patientId = await getPatientIdForUser(req.user.user_id);

      if (req.body.doctorName) {
        doctorId = await getDoctorIdByName(req.body.doctorName);
        if (!doctorId)
          return res.status(400).json({ error: "Doctor not found" });
      }
    } else if (isRole(req.user.role, "provider")) {
      patientId = Number(req.body.patientId);
      doctorId = await getDoctorIdForUser(req.user.user_id);
    } else {
      return res.status(403).json({ error: "Not allowed" });
    }

    if (!patientId || !doctorId) {
      return res.status(400).json({ error: "Missing patient or doctor info" });
    }

    const containerClient = await getContainerClient();

    const original = safeName(req.file.originalname || "file");
    const blobName = `${Date.now()}-${original}`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    await blockBlobClient.uploadData(req.file.buffer, {
      blobHTTPHeaders: {
        blobContentType: req.file.mimetype || "application/octet-stream",
      },
    });

    // Pick up description if provided
    const description = req.body.description || null;

    await sql.query`
      INSERT INTO MedicalRecords (patient_id, doctor_id, file_path, description, uploaded_at, blob_container)
      VALUES (${patientId}, ${doctorId}, ${blockBlobClient.url}, ${description}, GETUTCDATE(), ${containerClient.containerName})
    `;

    const file_url = createBlobSasUrl(containerClient, blobName, 15);

    res.json({
      message: "Uploaded",
      file_url,
      file_name: original,
      description,
    });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Failed to upload record" });
  }
});

/**
 * GET /api/records/my
 * - Patient only: list own files (with SAS URLs)
 */
router.get("/my", auth, async (req, res) => {
  try {
    if (!isRole(req.user.role, "patient")) {
      return res
        .status(403)
        .json({ error: "Only patients can view their files" });
    }
    const pid = await getPatientIdForUser(req.user.user_id);
    if (!pid)
      return res.status(404).json({ error: "Patient record not found" });

      const r = await sql.query`
  SELECT 
    mr.record_id,
    mr.file_path,
    mr.uploaded_at,
    mr.description,
    u.full_name AS doctor_name,
    d.specialization
  FROM MedicalRecords mr
  LEFT JOIN Doctors d ON mr.doctor_id = d.doctor_id
  LEFT JOIN Users u ON d.user_id = u.user_id
  WHERE mr.patient_id = ${pid}
  ORDER BY mr.uploaded_at DESC
`;



    const containerClient = await getContainerClient();
    const rows = r.recordset.map((row) => {
      const blobName = row.file_path.split("/").pop();
      const file_url = createBlobSasUrl(containerClient, blobName, 15);
      const file_name = blobName || "file";
      return { ...row, file_name, file_url };
    });

    res.json(rows);
  } catch (err) {
    console.error("List my records error:", err);
    res.status(500).json({ error: "Failed to fetch records" });
  }
});

/**
 * GET /api/records/doctor/patient/:patientId
 * - Provider only: list a patient's files (must have any appointment with that patient)
 */
router.get("/doctor/patient/:patientId", auth, async (req, res) => {
  try {
    if (!isRole(req.user.role, "provider")) {
      return res
        .status(403)
        .json({ error: "Only providers can view patient files" });
    }

    const patientId = Number(req.params.patientId);
    if (!patientId) return res.status(400).json({ error: "Invalid patientId" });

    const myDocId = await getDoctorIdForUser(req.user.user_id);
    if (!myDocId)
      return res.status(403).json({ error: "Doctor profile not found" });

    // Verify relationship (at least one appointment)
    const rel = await sql.query`
      SELECT TOP 1 1 FROM Appointments
      WHERE patient_id = ${patientId} AND doctor_id = ${myDocId}
    `;
    if (!rel.recordset.length) {
      return res.status(403).json({ error: "No relationship with patient" });
    }

    const r = await sql.query`
  SELECT record_id, file_path, uploaded_at
  FROM MedicalRecords
  WHERE patient_id = ${patientId} AND doctor_id = ${myDocId}
  ORDER BY uploaded_at DESC
`;

    const containerClient = await getContainerClient();
    const rows = r.recordset.map((row) => {
      const blobName = row.file_path.split("/").pop();
      const file_url = createBlobSasUrl(containerClient, blobName, 15);
      const file_name = blobName || "file";
      return { ...row, file_name, file_url };
    });

    res.json(rows);
  } catch (err) {
    console.error("Doctor list records error:", err);
    res.status(500).json({ error: "Failed to fetch records" });
  }
});

/**
 * DELETE /api/records/:recordId
 * - Patient can delete own record
 * - Provider can delete if they have any appointment with that patient
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
    if (!rec.recordset.length)
      return res.status(404).json({ error: "Record not found" });

    const { patient_id, file_path } = rec.recordset[0];

    if (isRole(req.user.role, "patient")) {
      const myPid = await getPatientIdForUser(req.user.user_id);
      if (myPid !== patient_id)
        return res.status(403).json({ error: "Not allowed" });
    } else if (isRole(req.user.role, "provider")) {
      const myDocId = await getDoctorIdForUser(req.user.user_id);
      if (!myDocId)
        return res.status(403).json({ error: "Doctor profile not found" });
      const hasRel = await sql.query`
        SELECT TOP 1 1 FROM Appointments
        WHERE patient_id = ${patient_id} AND doctor_id = ${myDocId}
      `;
      if (!hasRel.recordset.length)
        return res.status(403).json({ error: "Not allowed" });
    } else {
      return res.status(403).json({ error: "Not allowed" });
    }

    // Best-effort blob delete (container stays private)
    try {
      const containerClient = await getContainerClient();
      const blobName = file_path.split("/").pop();
      const blobClient = containerClient.getBlockBlobClient(blobName);
      await blobClient.deleteIfExists();
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

/**
 * OPTIONAL: GET /api/records/signed/:recordId
 * Returns a fresh SAS URL for a specific record (useful if the old one expired).
 */
router.get("/signed/:recordId", auth, async (req, res) => {
  try {
    const recordId = Number(req.params.recordId);
    if (!recordId) return res.status(400).json({ error: "Invalid recordId" });

    const rec = await sql.query`
      SELECT TOP 1 record_id, patient_id, file_path
      FROM MedicalRecords
      WHERE record_id = ${recordId}
    `;
    if (!rec.recordset.length)
      return res.status(404).json({ error: "Record not found" });

    const { patient_id, file_path } = rec.recordset[0];

    // same authorization rules as DELETE:
    if (isRole(req.user.role, "patient")) {
      const myPid = await getPatientIdForUser(req.user.user_id);
      if (myPid !== patient_id)
        return res.status(403).json({ error: "Not allowed" });
    } else if (isRole(req.user.role, "provider")) {
      const myDocId = await getDoctorIdForUser(req.user.user_id);
      if (!myDocId)
        return res.status(403).json({ error: "Doctor profile not found" });
      const hasRel = await sql.query`
        SELECT TOP 1 1 FROM Appointments
        WHERE patient_id = ${patient_id} AND doctor_id = ${myDocId}
      `;
      if (!hasRel.recordset.length)
        return res.status(403).json({ error: "Not allowed" });
    } else {
      return res.status(403).json({ error: "Not allowed" });
    }

    const containerClient = await getContainerClient();
    const blobName = file_path.split("/").pop();
    const file_url = createBlobSasUrl(containerClient, blobName, 15);

    res.json({ file_url });
  } catch (err) {
    console.error("Signed URL error:", err);
    res.status(500).json({ error: "Failed to create signed URL" });
  }
});

export default router;

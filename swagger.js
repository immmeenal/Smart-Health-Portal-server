// swagger.js (ESM)
import swaggerJsdoc from "swagger-jsdoc";

const servers = [
  { url: "http://localhost:3000", description: "Local" },
  // { url: "https://<your-prod-host>", description: "Prod" }
];

export const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: "3.1.0",
    info: {
      title: "Smart Health Portal API",
      version: "1.0.0",
      description:
        "OpenAPI documentation for the Healthcare backend (Patients, Providers, Appointments, Records, Auth).",
    },
    servers,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description:
            "Login to get a JWT, then click **Authorize** and paste: `Bearer <token>` or just `<token>`.",
        },
      },
      schemas: {
        // ---- Auth ----
        RegisterPatient: {
          type: "object",
          required: ["full_name", "email", "password", "user_role"],
          properties: {
            full_name: { type: "string" },
            email: { type: "string", format: "email" },
            password: { type: "string", minLength: 6 },
            phone_number: { type: "string" },
            user_role: { type: "string", enum: ["Patient"] },
            dob: { type: "string", format: "date" }
          },
        },
        RegisterProvider: {
          type: "object",
          required: ["full_name", "email", "password", "user_role"],
          properties: {
            full_name: { type: "string" },
            email: { type: "string", format: "email" },
            password: { type: "string", minLength: 6 },
            phone_number: { type: "string" },
            user_role: { type: "string", enum: ["Provider"] },
            specialization: { type: "string" },
            available_days: {
              type: "string",
              example: "Mon,Wed,Fri"
            }
          },
        },
        LoginRequest: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string" }
          }
        },
        LoginResponse: {
          type: "object",
          properties: {
            token: { type: "string" },
            role: { type: "string", enum: ["Patient", "Provider"] },
            full_name: { type: "string" }
          }
        },

        // ---- Doctors / Patients ----
        Doctor: {
          type: "object",
          properties: {
            doctor_id: { type: "integer" },
            full_name: { type: "string" },
            specialization: { type: "string" }
          }
        },
        Availability: {
          type: "object",
          properties: {
            doctor_id: { type: "integer" },
            available_days: { type: "string", example: "Mon,Wed,Fri" },
            working_hours: {
              type: "object",
              properties: {
                start: { type: "string", example: "10:00" },
                end: { type: "string", example: "17:00" },
                lunch: { type: "array", items: { type: "string" } }
              }
            },
            booked: { type: "array", items: { type: "string", format: "date-time" } }
          }
        },
        PatientSummary: {
          type: "object",
          properties: {
            patient_id: { type: "integer" },
            full_name: { type: "string" },
            gender: { type: "string", nullable: true }
          }
        },

        // ---- Appointments ----
        AppointmentCreateMy: {
          type: "object",
          required: ["doctor_id", "date", "time"],
          properties: {
            doctor_id: { type: "integer" },
            date: { type: "string", example: "2025-09-02" },
            time: { type: "string", example: "12:00:00" }
          }
        },
        Appointment: {
          type: "object",
          properties: {
            appointment_id: { type: "integer" },
            patient_id: { type: "integer" },
            doctor_id: { type: "integer" },
            status: { type: "string", enum: ["Scheduled", "Completed", "Cancelled"] },
            appointment_date: { type: "string", format: "date-time" },
            doctor_name: { type: "string", nullable: true },
            display_time: { type: "string", nullable: true }
          }
        },
        AppointmentStatusUpdate: {
          type: "object",
          required: ["status"],
          properties: {
            status: { type: "string", enum: ["Scheduled", "Completed", "Cancelled"] }
          }
        },

        // ---- Records ----
        MedicalRecord: {
          type: "object",
          properties: {
            record_id: { type: "integer" },
            patient_id: { type: "integer" },
            file_path: { type: "string" },
            file_name: { type: "string" },
            uploaded_at: { type: "string", format: "date-time" }
          }
        },
        ApiMessage: {
          type: "object",
          properties: { message: { type: "string" } }
        },
        ApiError: {
          type: "object",
          properties: { error: { type: "string" } }
        }
      }
    },
    security: [], // set per-route below
    paths: {
      // ---------- Auth ----------
      "/api/auth/register": {
        post: {
          tags: ["Auth"],
          summary: "Register a new user",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    { $ref: "#/components/schemas/RegisterPatient" },
                    { $ref: "#/components/schemas/RegisterProvider" }
                  ]
                }
              }
            }
          },
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/ApiMessage" } } } },
            400: { description: "Bad Request", content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } } }
          }
        }
      },
      "/api/auth/login": {
        post: {
          tags: ["Auth"],
          summary: "Login and receive JWT",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/LoginRequest" } } }
          },
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/LoginResponse" } } } },
            401: { description: "Invalid credentials" }
          }
        }
      },

      // ---------- Doctors ----------
      "/api/doctor/list": {
        get: {
          tags: ["Doctors"],
          summary: "Get doctor list",
          responses: {
            200: {
              description: "OK",
              content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Doctor" } } } }
            }
          }
        }
      },
      "/api/doctor/{id}/availability": {
        get: {
          tags: ["Doctors"],
          summary: "Get availability + booked slots",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "integer" } }
          ],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Availability" } } } },
            404: { description: "Doctor not found" }
          }
        }
      },
      "/api/doctor/patients": {
        get: {
          tags: ["Doctors"],
          summary: "Provider: list my patients (by appointments)",
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/PatientSummary" } } } } },
            403: { description: "Forbidden" }
          }
        }
      },
      "/api/doctor/patient/{patientId}/records": {
        get: {
          tags: ["Doctors"],
          summary: "Provider: get patient records (only if related by appointment)",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "patientId", in: "path", required: true, schema: { type: "integer" } }
          ],
          responses: {
            200: {
              description: "OK",
              content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/MedicalRecord" } } } }
            },
            403: { description: "Forbidden" }
          }
        }
      },
      "/api/doctor/patient/{patientId}/appointments": {
        get: {
          tags: ["Doctors"],
          summary: "Provider: appointments with this patient (only my own)",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "patientId", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Appointment" } } } } },
            403: { description: "Forbidden" }
          }
        }
      },

      // ---------- Appointments ----------
      "/api/appointments/my": {
        get: {
          tags: ["Appointments"],
          summary: "Patient: list my appointments",
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Appointment" } } } } },
            403: { description: "Forbidden" }
          }
        },
        post: {
          tags: ["Appointments"],
          summary: "Patient: book an appointment (uses dbo.ScheduleAppointment)",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/AppointmentCreateMy" } } }
          },
          responses: {
            201: { description: "Created", content: { "application/json": { schema: { type: "object", properties: { appointment_id: { type: "integer" } } } } } },
            400: { description: "Validation/proc error" },
            403: { description: "Forbidden" }
          }
        }
      },
      "/api/appointments/{id}": {
        put: {
          tags: ["Appointments"],
          summary: "Update appointment status",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/AppointmentStatusUpdate" } } }
          },
          responses: {
            200: { description: "Updated", content: { "application/json": { schema: { $ref: "#/components/schemas/ApiMessage" } } } },
            404: { description: "Not found" }
          }
        },
        delete: {
          tags: ["Appointments"],
          summary: "Cancel appointment (soft delete)",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            200: { description: "Cancelled", content: { "application/json": { schema: { $ref: "#/components/schemas/ApiMessage" } } } },
            404: { description: "Not found" }
          }
        }
      },

      // ---------- Records ----------
      "/api/records/upload": {
        post: {
          tags: ["Records"],
          summary: "Upload medical file (Patient: self, Provider: requires patientId)",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: {
                    file: { type: "string", format: "binary" },
                    patientId: { type: "integer", description: "Required only for Provider" }
                  },
                  required: ["file"]
                }
              }
            }
          },
          responses: {
            200: { description: "Uploaded", content: { "application/json": { schema: { type: "object", properties: { message: { type: "string" }, url: { type: "string" }, blob: { type: "string" } } } } } },
            403: { description: "Forbidden" }
          }
        }
      },
      "/api/records/my": {
        get: {
          tags: ["Records"],
          summary: "Patient: list my records",
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/MedicalRecord" } } } } }
          }
        }
      },
      "/api/patient/records": {
        get: {
          tags: ["Records"],
          summary: "Alias: Patient records (if routed via /patient)",
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/MedicalRecord" } } } } }
          }
        }
      },
      "/api/records/{recordId}": {
        delete: {
          tags: ["Records"],
          summary: "Delete a record (Patient owner or Provider related to patient)",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "recordId", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            200: { description: "Deleted", content: { "application/json": { schema: { $ref: "#/components/schemas/ApiMessage" } } } },
            403: { description: "Forbidden" },
            404: { description: "Not found" }
          }
        }
      }
    }
  },
  apis: [], // we’re building the spec programmatically; no JSDoc scan needed here
});

export default swaggerSpec;

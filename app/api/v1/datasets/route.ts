/*
 * AudioLab 2.0 — Dataset HTTP API
 *
 * GET  /api/v1/datasets?projectId=...
 * POST /api/v1/datasets
 *
 * Dataset metadata only. Audio files are
 * handled by the asset storage system later.
 *
 * Session identity and project roles are enforced by the mandatory API proxy.
 */

import { env } from "cloudflare:workers"; // What is env?: The env object is a special object provided by the Cloudflare Workers runtime that contains environment variables and bindings for the worker. It allows developers to access configuration settings, secrets, and other resources that are defined in the worker's environment. In this context, env.DB is used to access the D1 database binding for the AudioLab application.
import { z } from "zod"; // What is z?: Zod is a TypeScript-first schema declaration and validation library. It allows developers to define the shape and constraints of data structures, such as objects, arrays, and primitives, and provides runtime validation to ensure that the data conforms to the specified schema. Zod is particularly useful for validating user input, API requests, and responses, helping to catch errors early and maintain type safety in TypeScript projects.

import {
  datasetService,
  ProjectNotFoundError,
  DatasetAlreadyExistsError,
} from "@/lib/backend/services/datasets";

// ==========================================
// 1. REQUEST VALIDATION
// ==========================================
// Why define a schema?: Defining a schema allows us to validate incoming request data against a predefined structure and set of rules. This ensures that the data is in the expected format, contains all required fields, and adheres to any constraints (such as string length or allowed characters). By validating requests against a schema, we can catch errors early, provide meaningful error messages to clients, and prevent invalid data from being processed or stored in the database.
const ProjectIdSchema = z.string().uuid(); // Explain z.string().uuid(): This line defines a Zod schema for validating a project ID. The z.string() method specifies that the value must be a string, and the .uuid() method adds a constraint that the string must be a valid UUID (Universally Unique Identifier). This ensures that any project ID provided in the request is in the correct format before it is processed further.

const CreateDatasetSchema = z.strictObject({
  projectId: z.string().uuid(),
  name: z.string().trim().min(1).max(128),
  version: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000).default(""),
});

// ==========================================
// 2. AUTHORIZATION BOUNDARY
// ==========================================

// Session identity and resource permissions are enforced by the mandatory API proxy.

// ==========================================
// 3. GET /api/v1/datasets
// ==========================================

export async function GET(request: Request) {

  // Extract projectId from url

  const url = new URL(request.url); // What is "new" keyword?: The new keyword in JavaScript is used to create an instance of a class or constructor function. In this case, new URL(request.url) creates a new URL object that represents the URL of the incoming request. The URL object provides properties and methods to easily access different parts of the URL, such as the protocol, hostname, pathname, search parameters, and more. By creating a URL object from request.url, we can conveniently extract the projectId query parameter from the request.

  const projectId = url.searchParams.get("projectId"); // What is url.searchParams.get(): The url.searchParams.get() method is used to retrieve the value of a specific query parameter from the URL's search parameters. In this case, url.searchParams.get("projectId") retrieves the value of the "projectId" query parameter from the request URL. If the parameter is present, it returns its value as a string; if it is not present, it returns null. This allows us to access the projectId provided in the request and use it for further processing, such as validating and fetching datasets associated with that project.

  // Valide query parameter
  const parsed = ProjectIdSchema.safeParse(projectId); // What is safeParse(): The safeParse() method is a Zod function that attempts to validate and parse a value against a defined schema. In this case, ProjectIdSchema.safeParse(projectId) checks if the projectId obtained from the query parameter is a valid UUID string according to the ProjectIdSchema. If the validation is successful, it returns an object with a success property set to true and the parsed value. If the validation fails, it returns an object with success set to false and an error property containing details about the validation failure. This allows us to safely validate the projectId before proceeding with further operations.

  if (!parsed.success) {
    return Response.json({ error: "Invalid project ID." }, { status: 400 });
  }

  try {
    const datasets = await datasetService.list(env.DB, parsed.data); // What is parsed.data?: The parsed.data property contains the validated and parsed value of the projectId after successful validation using Zod's safeParse() method. In this case, if the projectId query parameter is a valid UUID string, parsed.data will hold that value, which can then be used to fetch the associated datasets from the database. If the validation had failed, parsed.data would not be available, and we would have returned an error response instead.

    return Response.json({ datasets }, { status: 200 });
  } catch (error) {
    if (error instanceof ProjectNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    } // Why check this?: Checking if the error is an instance of ProjectNotFoundError allows us to handle this specific error case differently from other types of errors. If the error is indeed a ProjectNotFoundError, we return a 404 Not Found response with a relevant error message, indicating that the requested project does not exist. This provides more meaningful feedback to the client about the nature of the error. If the error is of a different type, we can handle it in a more generic way, such as returning a 500 Internal Server Error response.

    console.error("GET datasets failed:", error);

    return Response.json(
      { error: "Failed to retrieve datasets." },
      { status: 500 },
    );
  }
}

// ==========================================
// 4. POST /api/v1/datasets
// ==========================================

export async function POST(request: Request) {

  let body: unknown;

  // Parse JSON from the request.
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Invalid JSON request body." },
      { status: 400 },
    );
  }

  // Validate the request body.
  const parsed = CreateDatasetSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      {
        error: "Invalid dataset data.",
        issues: parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  try {
    // Delegate dataset creation to the service.
    const dataset = await datasetService.create(env.DB, parsed.data);

    return Response.json({ dataset }, { status: 201 });
  } catch (error) {
    if (error instanceof ProjectNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }

    if (error instanceof DatasetAlreadyExistsError) {
      return Response.json({ error: error.message }, { status: 409 });
    }

    console.error("POST datasets failed:", error);

    return Response.json(
      { error: "Unable to register dataset." },
      { status: 500 },
    );
  }
}

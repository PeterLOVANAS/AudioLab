/*
 * AudioLab 2.0 — Projects HTTP API
 *
 * GET  /api/v1/projects
 * POST /api/v1/projects
 *
 * Verified sessions and existing admin membership are required for creation.
 * The first administrator is provisioned through controlled operator tooling.
 */

import { env } from "cloudflare:workers";
import { authenticate, requireSameOrigin, AuthError, type AuthSettings } from "@/lib/backend/auth/identity";
import { z } from "zod";

import {
  projectService,
  ProjectSlugTakenError,
} from "@/lib/backend/services/projects";

// ==========================================
// 1. REQUEST VALIDATION
// ==========================================

const CreateProjectSchema = z.strictObject({
  name: z.string().trim().min(1).max(128), // Project name must be between 1 and 128 characters.

  slug: z
    .string()
    .trim()
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), // Explain regex: The regex pattern /^[a-z0-9]+(?:-[a-z0-9]+)*$/ is used to validate the slug format. It ensures that the slug consists of lowercase letters (a-z), digits (0-9), and hyphens (-). The slug must start with a lowercase letter or digit, followed by zero or more groups of a hyphen and one or more lowercase letters or digits. This pattern allows for slugs like "my-project", "project123", or "example-slug", but disallows slugs that start or end with a hyphen, contain uppercase letters, or have consecutive hyphens.
}); // What is zod?: Zod is a TypeScript-first schema declaration and validation library. It allows developers to define the shape and constraints of data structures, such as objects, arrays, and primitives, and provides runtime validation to ensure that the data conforms to the specified schema. Zod is particularly useful for validating user input, API requests, and responses, helping to catch errors early and maintain type safety in TypeScript projects.
// What is z.strictObject(): z.strictObject() is a method provided by the Zod library that creates a schema for validating objects with strict property requirements. It ensures that the object being validated has exactly the properties defined in the schema, and no additional properties are allowed. If the object contains any extra properties not specified in the schema, the validation will fail. This is useful for enforcing strict data structures and preventing unexpected or unwanted properties from being present in the validated object.

// ==========================================
// 2. AUTHORIZATION BOUNDARY
// ==========================================

// Session identity and resource permissions are enforced by the mandatory API proxy.

// ==========================================
// 3. GET /api/v1/projects
// ==========================================

export async function GET() {

  try {
    const projects = await projectService.list(env.DB);

    return Response.json({ projects }, { status: 200 });
  } catch (error) {
    console.error("GET projects failed:", error);

    return Response.json(
      { error: "Failed to retrieve projects." },
      { status: 500 },
    );
  }
}

// ==========================================
// 4. POST /api/v1/projects
// ==========================================

export async function POST(request: Request) {

  // First parse the HTTP request body
  let body: unknown;

  try {
    body = await request.json(); // Why use await in this case?: Because request.json() is an asynchronous operation that returns a Promise. Using await allows us to wait for the Promise to resolve and get the parsed JSON body before proceeding with the rest of the function.
  } catch (error) {
    return Response.json(
      { error: "Invalid JSON request body." },
      { status: 400 },
    );
  }

  // Valide the request body against the schema
  // Ex. { "name": "My Project", "slug": "my-project" }
  const parsed = CreateProjectSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      {
        error: "Invalid project data.",
        issues: parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  try {
    // Call the service; do not execute SQL here.
    const settings=env as unknown as AuthSettings;
    const actor=await authenticate(env.DB,request,settings);requireSameOrigin(request,settings);
    const project = await projectService.createForAdmin(env.DB, parsed.data,actor);

    return Response.json({ project }, { status: 201 });
  } catch (error) {
    if(error instanceof AuthError)return Response.json({error:error.message},{status:error.status});
    // Map a known business conflict to HTTP 409.
    if (error instanceof ProjectSlugTakenError) {
      return Response.json({ error: error.message }, { status: 409 });
    }

    console.error("POST projects failed:", error);

    return Response.json(
      { error: "Unable to create project." },
      { status: 500 },
    );
  }
}

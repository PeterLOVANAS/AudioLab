/*
 * AudioLab 2.0 — Project Service
 *
 * This layer coordinates business operations.
 *
 * The HTTP route should communicate with this
 * service instead of writing SQL directly.
 */

import { AuthError, type AuthUser } from "@/lib/backend/auth/identity";
import type { Project, CreateProjectInput } from "@/lib/contracts/projects";

import { projectRepository } from "@/lib/backend/repositories/projects";

// What is export class?: A class that can be imported and used in other files.
// What is extends Error?: A class that inherits from the built-in Error class in JavaScript. It allows you to create custom error types with additional properties or methods.
export class ProjectSlugTakenError extends Error {
  constructor(slug: string) {
    super(`Project slug already taken: ${slug}`);
    // Use super() to call the constructor of the parent class (Error) and pass a custom error message that includes the slug that caused the error.
    this.name = "ProjectSlugTakenError";
  }
}

export const projectService = {
  // Retrieve available projects
  async list(db: D1Database): Promise<Project[]> {
    return projectRepository.findAll(db);
  },

  /** Only a verified existing project admin can provision another project.
   * Public signup is not introduced; creator ownership is granted atomically.
   * Uses the bound D1 instance (disposable local D1 in integration tests).
   */
  async createForAdmin(db:D1Database,input:CreateProjectInput,actor:AuthUser):Promise<Project>{
    if(!await db.prepare("SELECT 1 FROM project_members WHERE user_id=? AND role='admin' LIMIT 1").bind(actor.userId).first())throw new AuthError(403,"Project admin permission required.");
    const project={id:crypto.randomUUID(),name:input.name,slug:input.slug};
    if(!await projectRepository.insertWithAdmin(db,project,actor))throw new ProjectSlugTakenError(input.slug);
    return project;
  },

  async create(db: D1Database, input: CreateProjectInput): Promise<Project> {
    const project: Project = {
      id: crypto.randomUUID(), // Generate a unique identifier for the new project using the crypto.randomUUID() method.
      name: input.name,
      slug: input.slug,
    };
    const inserted = await projectRepository.insert(db, project);

    if (!inserted) {
      throw new ProjectSlugTakenError(project.slug); // If the insertion fails (i.e., the slug is already taken), throw a custom error to indicate that the project slug is already in use.
    }

    return project;
  },
};

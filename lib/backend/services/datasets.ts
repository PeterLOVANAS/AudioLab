/*
 * AudioLab 2.0 — Dataset Service
 *
 * Responsibilities:
 * - Check parent project existence.
 * - Generate dataset IDs.
 * - Coordinate database operations.
 * - Return meaningful business errors.
 */

import type { Dataset } from "@/lib/contracts/datasets";

import { datasetRepository } from "@/lib/backend/repositories/datasets";

// Frontend provides thes fields, backend generated datasetID.
export type CreateDatasetInput = Omit<Dataset, "id">; // Omit id when constructing a new dataset because The backend generates the id.

export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project not found: ${projectId}`);
    this.name = "ProjectNotFoundError";
  }
}

export class DatasetAlreadyExistsError extends Error {
  constructor() {
    super(
      "A dataset with this name and version " +
        "already exists in this project.",
    );

    this.name = "DatasetAlreadyExistsError";
  }
}

// ------------------------------------------
// Dataset service
// ------------------------------------------

export const datasetService = {
  async list(db: D1Database, projectId: string): Promise<Dataset[]> {
    const exists = await datasetRepository.ProjectExists(db, projectId);

    if (!exists) {
      throw new ProjectNotFoundError(projectId);
    }

    return datasetRepository.findByProject(db, projectId);
  },

  async create(db: D1Database, input: CreateDatasetInput): Promise<Dataset> {
    const exists = await datasetRepository.ProjectExists(db, input.projectId);

    if (!exists) {
      throw new ProjectNotFoundError(input.projectId);
    }

    const dataset: Dataset = {
      id: crypto.randomUUID(), // ID Create by backend.
      // Generate a unique identifier for the new dataset using the crypto.randomUUID() method.
      ...input, // What is ...input?: The ...input syntax is the spread operator in JavaScript/TypeScript. It takes all the properties from the input object and copies them into the new dataset object. This allows us to create a new dataset object that includes all the properties provided by the frontend (name, version, description, projectId) while also adding a newly generated id.
    };

    const inserted = await datasetRepository.insert(db, dataset);

    if (!inserted) {
      throw new DatasetAlreadyExistsError();
    }

    return dataset;
  },
};

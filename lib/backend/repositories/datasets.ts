/*
 * AudioLab 2.0 — Dataset Repository
 *
 * Responsibilities:
 * 1. Query datasets from Cloudflare D1.
 * 2. Check project existence.
 * 3. Insert new dataset records.
 *
 * This module should not handle HTTP requests
 * or frontend rendering.
 */

import type { Dataset } from "@/lib/contracts/datasets";

// why typescript used "export": To make the datasetRepository object available for import in other modules.
export const datasetRepository = {
  async ProjectExists(db: D1Database, projectId: string): Promise<boolean> {
    // ------------------------------------------
    // 1. Check whether a project exists
    // ------------------------------------------
    const project = await db
      .prepare(
        `SELECT id FROM projects
            WHERE id = ?
            LIMIT 1`,
      )
      .bind(projectId)
      .first<{ id: string }>(); // Explain .first<{id: string}>(): The .first<{id: string}>() method executes the prepared SQL query and retrieves the first matching row from the database. The <{id: string}> part is a TypeScript generic that tells the compiler that the result should be treated as an object with an "id" property of type string. This ensures type safety and proper typing for the returned data.
    // Run only for first matching row.
    return project !== null; // Explain project !== null: This line checks if the project variable is not null. If the query found a matching project, project will contain the first row of the result, and the function will return true. If no matching project was found, project will be null, and the function will return false. This indicates whether a project with the specified ID exists in the database.
  },

  // ------------------------------------------
  // 2. List datasets belonging to a project
  // ------------------------------------------
  async findByProject(db: D1Database, projectId: string): Promise<Dataset[]> {
    const result = await db
      .prepare(
        `SELECT id, project_id AS projectId, name, version, description FROM datasets
            WHERE project_id = ? 
            ORDER BY name ASC, version ASC`, // Explain SQL: This SQL query selects the columns "id", "project_id" (aliased as "projectId"), "name", "version", and "description" from the "datasets" table. It filters the results to include only those rows where the "project_id" matches the provided projectId. The results are then ordered first by the "name" column in ascending order, and then by the "version" column in ascending order. This ensures that datasets are grouped by name and sorted by version within each group.
      )
      .bind(projectId)
      .all<Dataset>(); // This ensure that the retrieved project is sorted by name and version
    return result.results;
  },

  // ------------------------------------------
  // 3. Insert a new dataset
  // ------------------------------------------

  async insert(db: D1Database, dataset: Dataset): Promise<boolean> {
    const result = await db
      .prepare(
        `INSERT INTO datasets (id, project_id, name, version, description) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(project_id, name, version) DO NOTHING`, // Explain SQL: This SQL query attempts to insert a new dataset into the "datasets" table with the specified "id", "project_id", "name", "version", and "description" values. The placeholders (?, ?, ?, ?, ?) are used to safely insert the values provided in the dataset object. The ON CONFLICT(project_id, name, version) DO NOTHING clause ensures that if a dataset with the same project_id, name, and version already exists, the insertion will be ignored, preventing duplicate entries.
      )
      .bind(
        dataset.id,
        dataset.projectId,
        dataset.name,
        dataset.version,
        dataset.description,
      )
      .run(); // Explain .bind(): The .bind() method is used to bind the actual values from the dataset object to the placeholders in the SQL query. It replaces the placeholders (?, ?, ?, ?, ?) with the corresponding values of dataset.id, dataset.projectId, dataset.name, dataset.version, and dataset.description, ensuring that the data is safely inserted into the database without risking SQL injection.
    return result.meta.changes === 1; // Explain result.meta.changes: The result.meta.changes property indicates the number of rows that were affected by the SQL operation. In this case, if the insertion was successful and a new dataset was added to the database, result.meta.changes will be equal to 1. If the insertion was ignored due to a conflict (i.e., a dataset with the same project_id, name, and version already exists), result.meta.changes will be 0.
  },
};

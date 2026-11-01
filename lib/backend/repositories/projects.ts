/*
 * AudioLab 2.0 — Project Repository
 *
 * The repository is responsible for SQL operations.
 *
 * It does not:
 * - Process HTTP requests
 * - Check user permissions
 * - Render frontend components
 */


import type { Project } from "@/lib/contracts/projects";

export const projectRepository = {

    //  Why used async?: Because database operations are asynchronous by nature, and we need to wait for the results before proceeding.
    // What is asynchronous?: Asynchronous means that the function can perform tasks that may take some time to complete (like database queries) without blocking the execution of other code. It allows the program to continue running while waiting for the operation to finish.
    async findAll(db: D1Database): Promise<Project[]> {
      const result = await db.prepare(
          `SELECT id, name, slug FROM projects ORDER BY name ASC`
      ) // Explain SQL: This SQL query selects the columns "id", "name", and "slug" from the "projects" table and orders the results by the "name" column in ascending order. The result will be a list of all projects in the database, sorted alphabetically by their names.
      .all<Project>(); // Explain .all<Project>(): The .all<Project>() method executes the prepared SQL query and retrieves all matching rows from the database. The <Project> part is a TypeScript generic that tells the compiler that the result should be treated as an array of Project objects, ensuring type safety and proper typing for the returned data.
      // .all = all matching rows | <Project> tells typescript the expected row structure.  
      return result.results; // Explain result.results: The result of the .all<Project>() method is an object that contains a "results" property, which holds the array of Project objects retrieved from the database. By returning result.results, we are providing the caller with just the array of projects, without any additional metadata or information about the query execution.

    }, 
    
    // Insert new project into D1, reture false if slug already exists
    async insert(db: D1Database, project: Project): Promise<boolean> {
      const result = await db.prepare(
          `INSERT INTO projects (id,name,slug)
          VALUES (?, ?, ?)
          ON CONFLICT(slug) DO NOTHING`
      ) // Explain SQL: This SQL query inserts a new project into the "projects" table with the specified "id", "name", and "slug" values. The placeholders (?, ?, ?) are used to safely insert the values provided in the project object. The ON CONFLICT(slug) DO NOTHING clause ensures that if a project with the same slug already exists, the insertion will be ignored, preventing duplicate entries.
      .bind(project.id, project.name, project.slug) // Explain .bind(): The .bind() method is used to bind the actual values from the project object to the placeholders in the SQL query. It replaces the placeholders (?, ?, ?) with the corresponding values of project.id, project.name, and project.slug, ensuring that the data is safely inserted into the database without risking SQL injection.
      .run(); // Explain .run(): The .run() method executes the prepared SQL statement with the bound values. It performs the insertion operation in the database and returns a result object that contains information about the execution, such as whether it was successful or if any rows were affected.
      
      return result.meta.changes === 1 // Explain result.meta.changes: The result.meta.changes property indicates the number of rows that were affected by the SQL operation. In this case, if the insertion was successful and a new project was added to the database, result.meta.changes will be equal to 1. If the insertion was ignored due to a conflict (i.e., a project with the same slug already exists), result.meta.changes will be 0. By returning result.meta.changes === 1, we are providing a boolean value indicating whether the insertion was successful (true) or not (false).
      // The new row inserted should === 1
    }
      
}; 

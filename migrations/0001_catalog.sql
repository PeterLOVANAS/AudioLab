-- AudioLab 2.0
-- Migration 0001: Projects and Datasets
--
-- This migration creates the first two tables.
-- Audio assets, annotation tasks, and assignments
-- will be introduced through later migrations.


-- ==========================================
-- 1. PROJECTS TABLE
-- ==========================================


CREATE TABLE projects (
    id TEXT PRIMARY KEY, 

    name TEXT NOT NUll, -- Project name, text only, and must be unique across all projects.
    slug TEXT NOT NULL UNIQUE, -- Project slug, text only, and must be unique across all projects.
    -- what is slug?: a slug is a URL-friendly version of the project name, typically lowercase and with spaces replaced by hyphens. It is used to create clean and readable URLs for the project.

    created_at TEXT NOT NULL 
        DEFAULT CURRENT_TIMESTAMP -- Timestamp of when the project was created.
); 



CREATE TABLE datasets (
    id TEXT PRIMARY KEY, 

    project_id TEXT NOT NULL, 

    name TEXT NOT NULL, -- Dataset name, text only, and must be unique within the project.

    version TEXT NOT NULL, -- Dataset version, text only, and must be unique within the project.

    description TEXT NOT NULL DEFAULT '', -- Dataset description, text only, and can be empty.

    created_at TEXT NOT NULL 
        DEFAULT CURRENT_TIMESTAMP, -- Timestamp of when the dataset was created.

    -- Every registered dataset belongs to a project. 
    FOREIGN KEY (project_id)
        REFERENCES projects (id) 
        ON DELETE RESTRICT, 

    -- What is foregin key?: A foreign key is a field (or collection of fields) in one table that uniquely identifies a row of another table. In this case, the project_id in the datasets table is a foreign key that references the id in the projects table. This establishes a relationship between datasets and their parent projects.
    
    -- WHat is ON DELETE RESTRICT?: This means that if a project is deleted, any datasets associated with that project cannot be deleted automatically. Instead, the deletion of the project will be restricted if there are any datasets linked to it. This ensures that datasets are not orphaned or lost when their parent project is removed.

    UNIQUE (project_id, name, version) -- Ensure that the combination of project_id, name, and version is unique across all datasets.
); 

-- Create index to help database efficiently find datasets associated with particular project
CREATE INDEX idx_datasets_project 
ON datasets(project_id); -- Create an index on the project_id column of the datasets table to improve query performance when filtering by project_id.

-- SQlite can use index to locate matching project_ids
/*
 * AudioLab 2.0 — Shared research API interface
 *
 * This file defines the functions the frontend
 * is allowed to call.
 *
 * Both the mock implementation and future
 * real backend client must follow this interface.
 */

import type { ProjectMember } from "@/lib/contracts/auth";

import type { Dataset, AudioAsset } from "@/lib/contracts/datasets";

import type {
  TaskDefinition,
  TaskInstance,
  LabellerTask,
} from "@/lib/contracts/tasks";

import type {
  Assignment,
  CreateAssignmentInput,
  TaskQueueItem,
} from "@/lib/contracts/assignments";

import type {
  AnnotationRevision,
  SaveAnnotationInput,
} from "@/lib/contracts/annotations";

// Asynchronous functions the frontend can call to access research data.
export type ResearchApi = {
  // Project members.
  listProjectMembers(): Promise<ProjectMember[]>;

  // Dataset Registry.
  listDatasets(): Promise<Dataset[]>;
  listAudioAssets(datasetId: string): Promise<AudioAsset[]>;
  registerDataset(dataset: Dataset): Promise<Dataset>;
  registerAudioAssets(assets: AudioAsset[]): Promise<AudioAsset[]>;

  // Admin Task Builder.
  listTaskDefinitions(): Promise<TaskDefinition[]>;
  createTaskDefinition(definition: TaskDefinition): Promise<TaskDefinition>;

  listTaskInstances(): Promise<TaskInstance[]>;
  createTaskInstances(instances: TaskInstance[]): Promise<TaskInstance[]>;

  // Admin Assignment Manager.
  listAssignments(): Promise<Assignment[]>;
  createAssignment(input: CreateAssignmentInput): Promise<Assignment>;

  // Labeller task access.
  getMyTaskQueue(userId: string): Promise<TaskQueueItem[]>;
  getLabellerTask(assignmentId: string, userId: string): Promise<LabellerTask>;

  // Labeller annotation revisions.
  getLatestAnnotation(
    assignmentId: string,
    userId: string,
  ): Promise<AnnotationRevision | null>;

  saveDraft(
    input: SaveAnnotationInput,
    userId: string,
  ): Promise<AnnotationRevision>;

  submitAnnotation(
    input: SaveAnnotationInput,
    userId: string,
  ): Promise<AnnotationRevision>;
};

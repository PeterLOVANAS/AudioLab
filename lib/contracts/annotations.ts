
/*
 * AudioLab 2.0 — Annotation response contracts
 *
 * This file defines how Labellers answer annotation blocks.
 *
 * The structures are independent of the research project.
 * A negation task, spoof-detection task, or transcription task
 * can all use the same response contracts.
 */

/*
 * ==========================================
 * 1. BASE ANSWER
 * ==========================================
 */

// Every answer must identify which annotation block it belongs to.
export type BaseAnswer = {
  blockId: string;
};

/*
 * ==========================================
 * 2. BASIC ANSWERS
 * ==========================================
 */

// Answer to a single-choice question.
export type SingleChoiceAnswer = BaseAnswer & {
  type: "single_choice";
  value: string;
};

// Answer to a multiple-choice question.
export type MultipleChoiceAnswer = BaseAnswer & {
  type: "multiple_choice";
  values: string[];
};

// Answer to a boolean question.
export type BooleanAnswer = BaseAnswer & {
  type: "boolean";
  value: boolean;
};

// Answer to a numerical question.
export type NumberAnswer = BaseAnswer & {
  type: "number";
  value: number;
};

// Answer to a rating scale.
export type RatingScaleAnswer = BaseAnswer & {
  type: "rating_scale";
  value: number;
};

// Answer to a free-text question.
export type TextAnswer = BaseAnswer & {
  type: "text";
  value: string;
};

// Answer to a transcription question.
export type TranscriptAnswer = BaseAnswer & {
  type: "transcript";
  text: string;
};

/*
 * ==========================================
 * 3. TIMELINE ANNOTATIONS
 * ==========================================
 *
 * Used for audio grounding, diarization,
 * word alignment, IPA phones, and other
 * time-aligned annotation tasks.
 */

// One labeled time interval.
export type TimelineInterval = {
  id: string;
  kind: "interval";
  tierId: string;

  startSeconds: number;
  endSeconds: number;

  label: string;

  // Optional link to a parent annotation.
  parentMarkId?: string;
};

// One labeled point in time.
export type TimelinePoint = {
  id: string;
  kind: "point";
  tierId: string;

  timeSeconds: number;
  label: string;
};

// A timeline may contain intervals and points.
export type TimelineMark =
  | TimelineInterval
  | TimelinePoint;

// All timeline annotations belonging to one block.
export type TimelineAnnotationAnswer = BaseAnswer & {
  type: "timeline_annotation";
  marks: TimelineMark[];
};

/*
 * ==========================================
 * 4. CONTINUOUS RATINGS
 * ==========================================
 *
 * Example: Emotional arousal over time.
 */

// One rating associated with a specific timestamp.
export type ContinuousRatingSample = {
  timeSeconds: number;
  value: number;
};

export type ContinuousRatingAnswer = BaseAnswer & {
  type: "continuous_rating";
  samples: ContinuousRatingSample[];
};

/*
 * ==========================================
 * 5. VERIFICATION AND COMPARISON
 * ==========================================
 */

// A vote on a proposed annotation.
export type CandidateVoteAnswer = BaseAnswer & {
  type: "candidate_vote";

  value: "AGREE" | "DISAGREE" | "UNSURE";

  correctedText?: string;
};

// A choice made between audio stimuli.
export type AudioComparisonAnswer = BaseAnswer & {
  type: "audio_comparison";

  selectedOption: string;
};

// A ranking of audio stimulus slots.
//
// Each inner array represents one rank group.
// More than one slot in a group means a tie.
//
// Example:
// [["audio_B"], ["audio_A", "audio_C"]]
export type RankingAnswer = BaseAnswer & {
  type: "ranking";

  orderedGroups: string[][];
};

/*
 * ==========================================
 * 6. COMBINED FIELD ANSWERS
 * ==========================================
 *
 * These are answers to ordinary input blocks.
 */

export type FieldAnswer =
  | SingleChoiceAnswer
  | MultipleChoiceAnswer
  | BooleanAnswer
  | NumberAnswer
  | RatingScaleAnswer
  | TextAnswer
  | TranscriptAnswer
  | TimelineAnnotationAnswer
  | ContinuousRatingAnswer
  | CandidateVoteAnswer
  | AudioComparisonAnswer
  | RankingAnswer;

/*
 * ==========================================
 * 7. REPEATED-GROUP ANSWERS
 * ==========================================
 *
 * Example: One set of responses per speaker.
 */

// Responses collected for one repeated item.
export type RepeatedItemAnswer = {
  itemId: string;
  answers: FieldAnswer[];
};

// Responses collected for the entire repeated group.
export type RepeatedGroupAnswer = BaseAnswer & {
  type: "repeated_group";
  items: RepeatedItemAnswer[];
};

/*
 * ==========================================
 * 8. ALL SUPPORTED ANNOTATION ANSWERS
 * ==========================================
 */

export type AnnotationAnswer =
  | FieldAnswer
  | RepeatedGroupAnswer;

/*
 * ==========================================
 * 9. SAVING ANNOTATIONS
 * ==========================================
 *
 * This is the payload supplied to the API
 * when saving or submitting an annotation.
 *
 * Identity and permissions will be checked
 * by the backend, not trusted from the browser.
 */

export type SaveAnnotationInput = {
  assignmentId: string;

  // Helps detect conflicting edits to the same annotation.
  expectedRevision: number;

  answers: AnnotationAnswer[];
};

/*
 * ==========================================
 * 10. SAVED ANNOTATION REVISION
 * ==========================================
 *
 * This represents a revision persisted by the backend.
 */

export type AnnotationStatus =
  | "draft"
  | "submitted";

export type AnnotationRevision = {
  id: string;

  assignmentId: string;
  taskInstanceId: string;
  authorUserId: string;

  revisionNumber: number;
  status: AnnotationStatus;

  answers: AnnotationAnswer[];

  createdAt: string;
};

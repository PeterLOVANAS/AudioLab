// Task purpose, independent of the audio asset's source domain.
export type TaskDomain = "sound" | "speech" | "general";

export type ChoiceOption = {
      value: string;  // value of whether it is male or female, or yes or no, etc.  This is the value that will be stored in the database when the user selects this option.
      label: string; // e.g. male and female for speaker gender, or yes and no for boolean question
}

export type BlockCondition = {
      blockId: string; 
      equals: string | boolean | number;
}

export type AnnotationScope = 
  | "clip"
  | "interval"
  | "speaker"
  | "event"
  | "audio_pair"
  | "candidate";

export type BaseBlock = {
      id: string; 
      label: string; 
      helpText?: string; 
      required: boolean; 

      scope?: AnnotationScope; // annotation scope default to clip level

      showwhen?: BlockCondition; // Optional condition controlling visibility.
}


// ==== Basic Annotation Blocks ====


// Choose exactly one option (e.g. MMAU qa)
export type SingleChoiceBlock = BaseBlock & {
    type: "single_choice"; 
    options: ChoiceOption[];
} // The use & is to combine the properties of BaseBlock and SingleChoiceBlock into a single type. This means that a SingleChoiceBlock will have all the properties of BaseBlock (id, label, helpText, required, scope, showwhen) as well as its own properties (type and options).
// Similar to inheritance in object-oriented programming, where a subclass inherits properties and methods from a superclass. In this case, SingleChoiceBlock "inherits" from BaseBlock, meaning it has all the properties of BaseBlock plus its own unique properties.


// Choose several options: e.g. select all audible sound sources.
export type MultipleChoiceBlock = BaseBlock & {
    type: "multiple_choice";
    options: ChoiceOption[];

    minSelections?: number; // Optional minimum number of selections required. If not specified, there is no minimum.
    maxSelections?: number; // Optional maximum number of selections allowed. If not specified, there is no maximum.
}


// Answer a Yes/No question  (e.g. full listining confirmation must be true)
export type BooleanBlock = BaseBlock & {
  type: "boolean" ;
  requiredValue?: boolean; 
}


// Enter numeric value (e.g. number of speakers, number of audible sound sources)
export type NumberBlock = BaseBlock & {
  type: "number" ; 

  min?: number; 
  max?: number;
  integerOnly?: boolean;
  unit?: string;
}

// Rate something on defined scale (e.g. Audio quality, sadness scale)
export type RatingScaleBlock = BaseBlock & {
  type: "rating_scale" ;

  min: number;
  max: number;
  step: number;

  minLabel?: string;
  maxLabel?: string;
}

// Enter free-form text:  e.g. audio captioning, annotation explanation , percievied acoustic artifact

// *** Question: Should there be customization about extraction behind this block.  For example: pass audio that you have listen in comma format.
export type TextBlock = BaseBlock & {
  type: "text" ; 

  multiline?: boolean;
  placeholder?: string;
  maxLength?: number;
}

// Transcribe speech in to text (Untimed transcription)
export type TranscriptBlock = BaseBlock & {
  type: "transcript" ; 

  language?: string; 
  notation?: "orthographic" | "ipa"
}


// === Temporal Annotation Block ===

export type TimelineTierLabelMode = 
  | "text" 
  | "choice"
  | "ipa" 
  | "speaker_id"

// properties share by all timeline tiers
export type TimelineTierBase = {
  id: string; 
  name: string; 

  labelMode: TimelineTierLabelMode;

  options?: ChoiceOption[]; // Only required if labelMode is "choice"

  parentTierId?: string; // Optional parent tier ID for hierarchical tiers. If specified, this tier is a child of the parent tier and will be displayed below it in the timeline.
} 



// A tier stores either:
// - Time intervals (start and end), or
// - Time points (a single timestamp)

// ( | {...}) means that the TimelineTier type can be one of two possible shapes. It can either be an object with the properties defined in the first block (kind: "interval" and allowOverlap: boolean) or an object with the properties defined in the second block (kind: "point"). This allows for flexibility in defining different types of timeline tiers, while still enforcing a consistent structure for each type.
export type TimelineTier = TimelineTierBase & (
  | {
    kind: "interval";
    allowOverlap: boolean;
  }

  | {
    kind: "point"; 
  }
)



// Advanced annotations workspace with MULTIPLE tiers.
// e,g. Speech intervals, IPA Phones, etc. 
export type TimelineAnnotationBlock = BaseBlock & {
  type: "timeline_annotation"; 

  tiers: TimelineTier[]; // Array of timeline tiers. Each tier defines a set of annotations that can be made on the timeline. The tiers can be hierarchical, with parent-child relationships defined by the parentTierId property in each tier.
}



// This block record ratings change over time
export type ContinuousRatingBlock = BaseBlock & {
    type: "continuous_rating"; 

    min: number; 
    max: number; 
    step: number;

    // Suggested time sampling interval
    sampleIntervalSeconds?: number; 
}



/*
 * ==========================================
 * 4. VERIFICATION AND COMPARISON BLOCKS
 * ==========================================
 */

// Evaluate a proposed annotation.
//
// Planned standard responses:
// - AGREE
// - DISAGREE
// - UNSURE
//
// This is one person's vote on a candidate.
// Independent voting by multiple people is configured
// separately using AnnotationPolicy.
export type CandidateVoteBlock = BaseBlock & {
  type: "candidate_vote";

  allowCorrection?: boolean;
};

// Compare two or more audio stimuli.
//
// Examples:
// - Original versus enhanced speech
// - TTS system A versus TTS system B
//
// Each stimulus slot identifies an audio recording
// supplied by the task instance.
export type AudioComparisonBlock = BaseBlock & {
  type: "audio_comparison";

  stimulusSlots: string[];
  options: ChoiceOption[];

  randomizeOrder?: boolean;
};

// Rank multiple audio stimuli.
//
// Example: Rank four synthetic voices by naturalness.
export type RankingBlock = BaseBlock & {
  type: "ranking";

  stimulusSlots: string[];
  allowTies: boolean;

  randomizeOrder?: boolean;
};

/*
 * ==========================================
 * 5. REPEATED GROUP BLOCK
 * ==========================================
 *
 * Used when a Labeller needs to annotate
 * an unknown number of entities.
 *
 * Examples:
 * - One group per speaker
 * - One group per sound event
 * - One group per detected anomaly
 */

// Individual input blocks supported by AudioLab.
export type FieldBlock =
  | SingleChoiceBlock
  | MultipleChoiceBlock
  | BooleanBlock
  | NumberBlock
  | RatingScaleBlock
  | TextBlock
  | TranscriptBlock
  | TimelineAnnotationBlock
  | ContinuousRatingBlock
  | CandidateVoteBlock
  | AudioComparisonBlock
  | RankingBlock;

// Repeat a collection of fields.
//
// We intentionally do not support nested repeated groups yet.
// This keeps the first renderer and validator manageable.
export type RepeatedGroupBlock = BaseBlock & {
  type: "repeated_group";

  itemLabel: string;

  minItems?: number;
  maxItems?: number;

  blocks: FieldBlock[];
};

/*
 * ==========================================
 * 6. COMBINED ANNOTATION BLOCK TYPE
 * ==========================================
 *
 * All Admin-configurable annotation blocks must
 * be represented by this union.
 */

export type AnnotationBlock =
  | FieldBlock
  | RepeatedGroupBlock;

/*
 * ==========================================
 * 7. ANNOTATION POLICY
 * ==========================================
 *
 * Defines how independently collected annotations
 * are submitted and reviewed.
 *
 * This is separate from a CandidateVoteBlock.
 */

export type AnnotationPolicy = {
  requiredIndependentVotes: number;
  blindToOthers: boolean;
  requiresReview: boolean;
};

/*
 * ==========================================
 * 8. AUDIO WORKSPACE CONFIGURATION
 * ==========================================
 *
 * These are editing and visualization tools,
 * not annotation-answer blocks.
 *
 * Tasks can enable the appropriate tools without
 * requiring the Admin to create separate questions.
 */

export type AudioWorkspaceConfig = {
  waveform?: boolean;
  spectrogram?: boolean;
  pitch?: boolean;
  formants?: boolean;
  mfcc?: boolean;

  allowTextGridImport?: boolean;
};

/*
 * ==========================================
 * 9. REUSABLE TASK DEFINITION
 * ==========================================
 *
 * Created by an Admin.
 *
 * A definition combines annotation blocks,
 * instructions, collection policy, and editor tools.
 */

export type TaskDefinition = {
  id: string;
  version: number;

  name: string;
  description: string;
  domain: TaskDomain;
  instructions: string;

  blocks: AnnotationBlock[];
  policy: AnnotationPolicy;

  workspace?: AudioWorkspaceConfig;
};

/*
 * ==========================================
 * 10. SOURCE METADATA
 * ==========================================
 *
 * Preserves provenance from the original dataset.
 * These fields are not automatically shown to Labellers.
 */

export type TaskMetadata = {
  sourceRecordId?: string;
  sourceTask?: string;
  split?: string;
  category?: string;
  subCategory?: string;
  difficulty?: string;
};

/*
 * ==========================================
 * 11. AUDIO STIMULI
 * ==========================================
 *
 * Most tasks use one primary audio recording.
 *
 * Comparison tasks may additionally require
 * multiple audio stimuli, such as A and B.
 */

// Internal association between a slot and an audio asset.
export type TaskAudioStimulus = {
  slotId: string;
  assetId: string;
};

// Playback information returned to an authorized Labeller.
export type PlaybackStimulus = {
  slotId: string;
  audioUrl: string;
};

/*
 * ==========================================
 * 12. CONCRETE TASK INSTANCE
 * ==========================================
 *
 * A specific annotation job using a real audio asset.
 *
 * Blocks and instructions are resolved and frozen
 * when the task is created.
 */

export type TaskInstance = {
  id: string;

  definitionId: string;
  definitionVersion: number;

  // Primary audio asset.
  assetId: string;

  instructions: string;
  blocks: AnnotationBlock[];

  // Optional information intentionally shown to Labellers.
  targetConcept?: string;
  candidateText?: string;

  // Additional audio for comparison/ranking tasks.
  stimuli?: TaskAudioStimulus[];

  workspace?: AudioWorkspaceConfig;

  // Administrative metadata.
  metadata: TaskMetadata;
};

/*
 * ==========================================
 * 13. LABELLER-FACING TASK
 * ==========================================
 *
 * The backend must check that the Labeller is
 * authorized to access this task.
 *
 * Private reference answers and internal dataset
 * metadata must not appear in this response.
 */

export type LabellerTask = {
  id: string;

  definitionId: string;
  definitionVersion: number;

  audioUrl: string;

  instructions: string;
  blocks: AnnotationBlock[];

  targetConcept?: string;
  candidateText?: string;

  // Authorized playback URLs for additional stimuli.
  stimuli?: PlaybackStimulus[];

  workspace?: AudioWorkspaceConfig;
};



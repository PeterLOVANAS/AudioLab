
// Storage Location
export type StorageProvider = "local" | "r2" | "s3" ; 

export type AudioDomain = "sound" | "speech" | "mixed" | "unknown"; 

// registed colleciton of audios
export type Dataset = {
    id: string ; 
    projectId: string ;

    name: string ; 
    version: string ; 
    description: string ;
}

// Identifies where an audio is physically stored
export type AudioStorage = {
    provider: StorageProvider ;
    key: string ;
}


// Metadata per one audio recording
export type AudioAsset = {
    id: string;  
    datasetId: string; 
    originalPath: string; // The original path of the audio file, which is used to identify the audio file in the storage provider. It is a unique identifier for the audio file within the dataset.
    storage: AudioStorage; // The storage information for the audio file, which includes the provider and key. This is used to locate and access the audio file in the storage provider.

    sourceDataset?: string; 
    sourceDomain?: AudioDomain;
    sourceRecordId?: string; 
    split?: string; 
    sizeBytes?: number;

    durationSeconds?: number;   // ? is optional
    mimeType?: string; // Speech tasks
    sha256?: string; // Speech tasks
    sampleRate?: number; // Speech tasks
    channels?: number; // Speech tasks

}

// In case the dataset required QA labelling
export type SourceQuestion = {
  id: string;
  assetId: string;
  prompt: string;
  choices: string[];

  category?: string;
  subCategory?: string;
  difficulty?: string;
};






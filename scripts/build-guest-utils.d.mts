export function cleanupFailedBuild(stageDir: string, distDir: string, oldDir: string): Promise<void>;
export function sweepStaleBackups(distDir: string): Promise<void>;
export function swapStageToDist(stageDir: string, distDir: string, oldDir: string): Promise<void>;

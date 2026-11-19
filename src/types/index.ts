export type Risk = "safe" | "review" | "protected";

export type CleanAction = "trash" | "permanent";

export type ProjectType =
  | "nodejs"
  | "typescript"
  | "python"
  | "rust"
  | "go"
  | "gradle"
  | "maven"
  | "dotnet"
  | "php"
  | "ruby"
  | "unknown";

export interface RuleDefaults {
  mode: "dry-run" | "clean";
  useTrash: boolean;
  maxDepth: number;
  largeThresholdMB: number;
}

/** Reglas condicionadas al tipo de proyecto detectado (p. ej. .NET). */
export interface ProjectRuleSet {
  safe?: string[];
  review?: string[];
  protected?: string[];
  safeNegations?: string[];
}

export interface CleanerRuleSet {
  version: number;
  defaults: RuleDefaults;
  safe: string[];
  review: string[];
  protected: string[];
  projectRules?: Partial<Record<ProjectType, ProjectRuleSet>>;
  /** Rutas excluidas (empiezan por "!"): fuerzan review sobre safe. */
  safeNegations?: string[];
}

export interface ScanEntry {
  absolutePath: string;
  relativePath: string;
  type: "file" | "directory";
  risk: Risk;
  reason: string;
  sizeBytes: number;
  matchedRule?: string;
}

export interface ArtifactSummary {
  safeCount: number;
  reviewCount: number;
  protectedCount: number;
  safeBytes: number;
  reviewBytes: number;
  protectedBytes: number;
}

export interface ScanSummary {
  target: string;
  totalFiles: number;
  totalDirectories: number;
  totalSizeBytes: number;
  safeBytes: number;
  reviewBytes: number;
  protectedBytes: number;
  lastModified: string;
  generatedAt: string;
}

export interface ScanReport {
  id: string;
  target: string;
  projectTypes: ProjectType[];
  meta: ProjectMeta;
  generatedAt: string;
  warnings: string[];
  summary: ScanSummary;
  entries: ScanEntry[];
}

/** Metadatos enriquecidos del proyecto (fase 5). */
export interface ProjectMeta {
  types: ProjectType[];
  markers: string[];
  languages: string[];
  packageManagers: string[];
  frameworks: string[];
  /** Comandos de regeneración sugeridos; NUNCA se ejecutan automáticamente. */
  regenerationCommands: string[];
  isGitRepo: boolean;
  gitPendingChanges: boolean;
  gitStatusOutput?: string;
}

export interface ProjectInfo {
  name: string;
  path: string;
  relativePath: string;
  types: ProjectType[];
  markers: string[];
  meta: ProjectMeta;
  sizeBytes: number;
  lastModified: string;
  hasArtifacts: boolean;
  artifacts: ArtifactSummary;
  entries: ScanEntry[];
  warnings: string[];
}

export interface RootScanSummary {
  projectCount: number;
  projectsWithArtifacts: number;
  totalSizeBytes: number;
  safeBytes: number;
  reviewBytes: number;
  artifactCount: number;
}

export interface RootScanReport {
  id: string;
  root: string;
  generatedAt: string;
  rulesSource: string;
  summary: RootScanSummary;
  projects: ProjectInfo[];
  warnings: string[];
}

export interface ScanOptions {
  rulesSource?: string;
  onProject?: (project: ProjectInfo) => void;
}

export interface ReportPaths {
  json: string;
  markdown: string;
}

export interface CleanPlanItem {
  entry: ScanEntry;
  action: CleanAction;
  approved: boolean;
  /** Motivo de bloqueo (p. ej. descendiente protegido en borrado permanente). */
  blocked?: string;
}

export interface CleanPlan {
  id: string;
  scanReportId: string;
  target: string;
  projectTypes: ProjectType[];
  items: CleanPlanItem[];
  totalBytes: number;
  createdAt: string;
}

export interface CleanSelection {
  includeReview?: boolean;
  only?: string[];
  exclude?: string[];
}

export interface CleanOptions extends CleanSelection {
  dryRun?: boolean;
  yes?: boolean;
  permanent?: boolean;
  trashDir?: string;
  auditPath?: string;
  reportsDir?: string;
  /** Inyectable en tests; por defecto, readline interactivo. */
  ask?: (prompt: string) => Promise<string>;
  isInteractive?: boolean;
}

export interface AuditRecord {
  timestamp: string;
  target: string;
  relativePath: string;
  risk: Risk;
  action: CleanAction | "restore" | "purge";
  sizeBytes: number;
  approvedBy: "human";
  result:
    | "deleted"
    | "trashed"
    | "failed"
    | "skipped"
    | "restored"
    | "conflict"
    | "purged";
  planId?: string;
  sessionId?: string;
  overwritten?: boolean;
  error?: string;
}

export interface CleanResultItem {
  entry: ScanEntry;
  action: CleanAction;
  result: "trashed" | "deleted" | "failed" | "skipped";
  error?: string;
  storedPath?: string;
}

export interface GitVerification {
  available: boolean;
  output: string;
  deletedTracked: string[];
}

export interface CleanResult {
  id: string;
  planId: string;
  scanReportId: string;
  target: string;
  projectTypes: ProjectType[];
  action: CleanAction;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  items: CleanResultItem[];
  executedCount: number;
  failedCount: number;
  skippedCount: number;
  freedBytes: number;
  keptCount: number;
  trashSessionDir?: string;
  auditPath?: string;
  git?: GitVerification;
  warnings: string[];
}

export interface TrashItemMeta {
  originalPath: string;
  relativePath: string;
  storedPath: string;
  timestamp: string;
  sizeBytes: number;
  risk: Risk;
  action: "trash";
  reason: string;
  planHash: string;
  /** Estado de restauración (fase 4). */
  restored?: boolean;
  restoredAt?: string;
  restoredPath?: string;
}

export interface TrashSession {
  id: string;
  target: string;
  createdAt: string;
  planId: string;
  planHash: string;
  sessionDir: string;
  itemsDir: string;
  items: TrashItemMeta[];
}

export type RestoreConflictMode = "cancel" | "suffix" | "overwrite";

export type TrashSessionStatus =
  "restorable" | "partial" | "restored" | "unrestorable";

export interface TrashSessionInfo {
  sessionId: string;
  sessionDir: string;
  createdAt: string;
  planId: string;
  planHash: string;
  itemCount: number;
  pendingCount: number;
  restoredCount: number;
  restorableCount: number;
  totalBytes: number;
  status: TrashSessionStatus;
}

export interface RestorePlanItem {
  meta: TrashItemMeta;
  storedExists: boolean;
  originalExists: boolean;
  conflict: boolean;
  resolution: RestoreConflictMode;
  approved: boolean;
}

export interface RestorePlan {
  id: string;
  target: string;
  sessionId: string;
  sessionDir: string;
  originalPlanId: string;
  items: RestorePlanItem[];
  totalBytes: number;
  createdAt: string;
  overwriteApproved: boolean;
}

export interface RestoreResultItem {
  relativePath: string;
  originalPath: string;
  restoredPath?: string;
  result: "restored" | "failed" | "skipped" | "conflict";
  risk: Risk;
  sizeBytes: number;
  error?: string;
}

export interface RestoreResult {
  id: string;
  target: string;
  sessionId: string;
  originalPlanId: string;
  startedAt: string;
  finishedAt: string;
  items: RestoreResultItem[];
  restoredCount: number;
  failedCount: number;
  skippedCount: number;
  conflictCount: number;
  restoredBytes: number;
  auditPath?: string;
  warnings: string[];
}

export interface RestoreSelection {
  only?: string[];
  all?: boolean;
}

export interface RestoreOptions {
  dryRun?: boolean;
  yes?: boolean;
  onConflict?: RestoreConflictMode;
  auditPath?: string;
  reportsDir?: string;
  ask?: (prompt: string) => Promise<string>;
  isInteractive?: boolean;
}

export interface TrashAdminOptions {
  session?: string;
  remove?: boolean;
  removeCompleted?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  auditPath?: string;
  reportsDir?: string;
  ask?: (prompt: string) => Promise<string>;
  isInteractive?: boolean;
}

export interface TrashPurgeItem {
  sessionId: string;
  result: "purged" | "failed" | "skipped";
  sizeBytes: number;
  error?: string;
}

export interface TrashPurgeReport {
  id: string;
  target: string;
  generatedAt: string;
  sessions: TrashSessionInfo[];
  eligible: string[];
  purged: TrashPurgeItem[];
  kept: string[];
  freedBytes: number;
  errors: string[];
}

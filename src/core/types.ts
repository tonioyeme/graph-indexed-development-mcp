/**
 * GID Core Types for MCP Server
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Node Types
// ═══════════════════════════════════════════════════════════════════════════════

export type NodeType =
  | 'Feature'
  | 'Component'
  | 'Interface'
  | 'Data'
  | 'File'
  | 'Test'
  | 'Decision';

export type NodeStatus = 'draft' | 'in_progress' | 'active' | 'deprecated';

export type FeaturePriority = 'core' | 'supporting' | 'generic';

export type ComponentLayer = 'interface' | 'application' | 'domain' | 'infrastructure';

export interface Node {
  type: NodeType;
  description?: string;
  status?: NodeStatus;
  priority?: FeaturePriority;
  layer?: ComponentLayer;
  path?: string;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Edge Types
// ═══════════════════════════════════════════════════════════════════════════════

export type EdgeRelation =
  | 'implements'
  | 'depends_on'
  | 'calls'
  | 'reads'
  | 'writes'
  | 'tested_by'
  | 'defined_in'
  | 'decided_by';

export interface Edge {
  from: string;
  to: string;
  relation: EdgeRelation;
  coupling?: 'tight' | 'loose';
  optional?: boolean;
  description?: string;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Graph Structure
// ═══════════════════════════════════════════════════════════════════════════════

export interface IntegrityRule {
  name: string;
  description: string;
  severity: 'error' | 'warning' | 'info';
  check?: string;
  threshold?: number;
}

export interface Graph {
  nodes: Record<string, Node>;
  edges: Edge[];
  integrity_rules?: IntegrityRule[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Query Results
// ═══════════════════════════════════════════════════════════════════════════════

export interface ImpactResult {
  node: string;
  nodeType: NodeType;
  directDependents: string[];
  transitiveDependents: string[];
  affectedFeatures: string[];
  affectedTests: string[];
  impactScore: number;
}

export interface DependencyResult {
  node: string;
  dependencies: Array<{ name: string; relation: EdgeRelation; depth: number }>;
  transitiveDependencies: Array<{ name: string; relation: EdgeRelation; depth: number }>;
}

export interface CommonCauseResult {
  nodeA: string;
  nodeB: string;
  commonDependencies: string[];
  suggestion: string;
}

export interface PathResult {
  from: string;
  to: string;
  path: string[];
  hops: number;
  relations: EdgeRelation[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Validation Results
// ═══════════════════════════════════════════════════════════════════════════════

export interface ValidationIssue {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  nodes?: string[];
  edges?: Edge[];
  suggestion?: string;
}

// TODO: TurboMQ metrics - needs further discussion
// TurboMQ is designed for modular architectures (microservices) where intra-module
// cohesion is expected. For layered architectures (controller -> service -> repository),
// inter-layer dependencies are the DESIGN GOAL, making TurboMQ less suitable.
// Consider enabling this for users with modular architectures as an optional feature.
// See: planning/METRICS-DISCUSSION.md
//
// export interface ModularityMetrics {
//   turboMQ: number;        // 0-1, higher is better modularity
//   coupling: number;       // 0-1, lower is better (external edges / total edges)
//   cohesion: number;       // 0-1, higher is better (internal edges / total edges)
//   avgFanIn: number;       // Average incoming dependencies
//   avgFanOut: number;      // Average outgoing dependencies
//   maxFanIn: number;       // Highest fan-in (most depended-on)
//   maxFanOut: number;      // Highest fan-out (most dependencies)
// }

export interface ValidationResult {
  passed: boolean;
  healthScore: number;
  // metrics?: ModularityMetrics;  // TODO: Enable for modular architectures
  issues: ValidationIssue[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Suggestion Types
// ═══════════════════════════════════════════════════════════════════════════════

export type SuggestionLevel = 'deterministic' | 'heuristic' | 'ai';

export interface Suggestion {
  level: SuggestionLevel;
  type: string;
  message: string;
  suggestion?: string;
  fix?: {
    action: 'add_edge' | 'remove_edge' | 'add_node' | 'remove_node' | 'modify_node';
    from?: string;
    to?: string;
    relation?: EdgeRelation;
    node?: string;
    properties?: Record<string, unknown>;
  };
}

export interface SuggestionResult {
  healthScore: number;
  suggestions: Suggestion[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Graph Summary
// ═══════════════════════════════════════════════════════════════════════════════

export interface GraphSummary {
  path: string;
  stats: {
    totalNodes: number;
    features: number;
    components: number;
    interfaces: number;
    data: number;
    files: number;
    tests: number;
    totalEdges: number;
  };
  healthScore: number;
  features: string[];
  recentlyModified?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Errors
// ═══════════════════════════════════════════════════════════════════════════════

export type GIDErrorCode =
  | 'PARSE_ERROR'
  | 'SCHEMA_ERROR'
  | 'NODE_NOT_FOUND'
  | 'EDGE_INVALID'
  | 'CYCLE_DETECTED'
  | 'FILE_NOT_FOUND'
  | 'FILE_EXISTS'
  | 'AI_ERROR'
  | 'LICENSE_ERROR';

export class GIDError extends Error {
  constructor(
    message: string,
    public code: GIDErrorCode,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'GIDError';
  }
}

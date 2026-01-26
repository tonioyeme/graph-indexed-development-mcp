/**
 * GID Graph Class for MCP Server
 */

import { Graph, Node, Edge, EdgeRelation, GIDError } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Graph Class
// ═══════════════════════════════════════════════════════════════════════════════

export class GIDGraph {
  private nodes: Map<string, Node>;
  private edges: Edge[];
  private outgoingEdges: Map<string, Edge[]>;
  private incomingEdges: Map<string, Edge[]>;

  constructor(data: Graph) {
    this.nodes = new Map(Object.entries(data.nodes));
    this.edges = data.edges;

    this.outgoingEdges = new Map();
    this.incomingEdges = new Map();

    for (const edge of this.edges) {
      if (!this.outgoingEdges.has(edge.from)) {
        this.outgoingEdges.set(edge.from, []);
      }
      this.outgoingEdges.get(edge.from)!.push(edge);

      if (!this.incomingEdges.has(edge.to)) {
        this.incomingEdges.set(edge.to, []);
      }
      this.incomingEdges.get(edge.to)!.push(edge);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Node Operations
  // ═══════════════════════════════════════════════════════════════════════════

  getNode(id: string): Node | undefined {
    return this.nodes.get(id);
  }

  getNodeOrThrow(id: string): Node {
    const node = this.nodes.get(id);
    if (!node) {
      throw new GIDError(
        `Node not found: "${id}"`,
        'NODE_NOT_FOUND',
        { nodeId: id, availableNodes: this.getNodeIds().slice(0, 10) }
      );
    }
    return node;
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  getNodeIds(): string[] {
    return Array.from(this.nodes.keys());
  }

  getNodes(): Map<string, Node> {
    return this.nodes;
  }

  getNodesByType(type: Node['type']): Array<[string, Node]> {
    return Array.from(this.nodes.entries()).filter(([_, node]) => node.type === type);
  }

  getFeatures(): Array<[string, Node]> {
    return this.getNodesByType('Feature');
  }

  getComponents(): Array<[string, Node]> {
    return this.getNodesByType('Component');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Edge Operations
  // ═══════════════════════════════════════════════════════════════════════════

  getOutgoingEdges(nodeId: string, relation?: EdgeRelation): Edge[] {
    const edges = this.outgoingEdges.get(nodeId) ?? [];
    if (relation) {
      return edges.filter((e) => e.relation === relation);
    }
    return edges;
  }

  getIncomingEdges(nodeId: string, relation?: EdgeRelation): Edge[] {
    const edges = this.incomingEdges.get(nodeId) ?? [];
    if (relation) {
      return edges.filter((e) => e.relation === relation);
    }
    return edges;
  }

  getAllEdges(): Edge[] {
    return this.edges;
  }

  getEdges(): Edge[] {
    return this.edges;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Dependency Queries
  // ═══════════════════════════════════════════════════════════════════════════

  getDependencies(nodeId: string): string[] {
    return this.getOutgoingEdges(nodeId, 'depends_on').map((e) => e.to);
  }

  getDependents(nodeId: string): string[] {
    return this.getIncomingEdges(nodeId, 'depends_on').map((e) => e.from);
  }

  getAllDependencies(nodeId: string, visited = new Set<string>()): string[] {
    if (visited.has(nodeId)) return [];
    visited.add(nodeId);

    const directDeps = this.getDependencies(nodeId);
    const allDeps: string[] = [...directDeps];

    for (const dep of directDeps) {
      const transitiveDeps = this.getAllDependencies(dep, visited);
      allDeps.push(...transitiveDeps);
    }

    return [...new Set(allDeps)];
  }

  getAllDependents(nodeId: string, visited = new Set<string>()): string[] {
    if (visited.has(nodeId)) return [];
    visited.add(nodeId);

    const directDeps = this.getDependents(nodeId);
    const allDeps: string[] = [...directDeps];

    for (const dep of directDeps) {
      const transitiveDeps = this.getAllDependents(dep, visited);
      allDeps.push(...transitiveDeps);
    }

    return [...new Set(allDeps)];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Feature Queries
  // ═══════════════════════════════════════════════════════════════════════════

  getImplementedFeatures(componentId: string): string[] {
    return this.getOutgoingEdges(componentId, 'implements').map((e) => e.to);
  }

  getImplementingComponents(featureId: string): string[] {
    return this.getIncomingEdges(featureId, 'implements').map((e) => e.from);
  }

  getAffectedFeatures(nodeId: string): string[] {
    const affectedComponents = [nodeId, ...this.getAllDependents(nodeId)];
    const features = new Set<string>();

    for (const compId of affectedComponents) {
      const implFeatures = this.getImplementedFeatures(compId);
      for (const f of implFeatures) {
        features.add(f);
      }
    }

    return [...features];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Test Queries
  // ═══════════════════════════════════════════════════════════════════════════

  getTests(componentId: string): string[] {
    return this.getOutgoingEdges(componentId, 'tested_by').map((e) => e.to);
  }

  getAffectedTests(nodeId: string): string[] {
    const affectedComponents = [nodeId, ...this.getAllDependents(nodeId)];
    const tests = new Set<string>();

    for (const compId of affectedComponents) {
      const compTests = this.getTests(compId);
      for (const t of compTests) {
        tests.add(t);
      }
    }

    return [...tests];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Utility
  // ═══════════════════════════════════════════════════════════════════════════

  getStats(): {
    nodeCount: number;
    edgeCount: number;
    featureCount: number;
    componentCount: number;
    interfaceCount: number;
    dataCount: number;
    fileCount: number;
    testCount: number;
  } {
    return {
      nodeCount: this.nodes.size,
      edgeCount: this.edges.length,
      featureCount: this.getFeatures().length,
      componentCount: this.getComponents().length,
      interfaceCount: this.getNodesByType('Interface').length,
      dataCount: this.getNodesByType('Data').length,
      fileCount: this.getNodesByType('File').length,
      testCount: this.getNodesByType('Test').length,
    };
  }

  toJSON(): Graph {
    return {
      nodes: Object.fromEntries(this.nodes),
      edges: this.edges,
    };
  }
}
